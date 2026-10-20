extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, IntoVal, Symbol, Val, Vec,
};

const START: u64 = 1_000_000;
const REVIEW: u64 = 3_600;
const DEADLINE: u64 = START + 86_400;
const AMOUNT: i128 = 5_000_000;

struct Setup {
    env: Env,
    escrow: TaskEscrowClient<'static>,
    token: TokenClient<'static>,
    other_token: Address,
    admin: Address,
    arbiter: Address,
    client: Address,
    agent: Address,
    stranger: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let other = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());

    let admin = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let id = env.register(
        TaskEscrow,
        (
            admin.clone(),
            arbiter.clone(),
            REVIEW,
            vec![&env, sac.address()],
        ),
    );
    let escrow = TaskEscrowClient::new(&env, &id);

    let client = Address::generate(&env);
    let agent = Address::generate(&env);
    let stranger = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address())
        .mock_all_auths()
        .mint(&client, &(AMOUNT * 10));
    StellarAssetClient::new(&env, &other.address())
        .mock_all_auths()
        .mint(&client, &(AMOUNT * 10));

    Setup {
        env,
        escrow,
        token,
        other_token: other.address(),
        admin,
        arbiter,
        client,
        agent,
        stranger,
    }
}

fn tid(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn evidence(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xee; 32])
}

impl Setup {
    fn fund(&self, n: u8) -> BytesN<32> {
        let id = tid(&self.env, n);
        self.escrow
            .fund(&id, &self.client, &self.token.address, &AMOUNT, &DEADLINE);
        id
    }

    fn assigned(&self, n: u8) -> BytesN<32> {
        let id = self.fund(n);
        self.escrow.assign(&id, &self.agent);
        id
    }

    fn submitted(&self, n: u8) -> BytesN<32> {
        let id = self.assigned(n);
        self.escrow.submit(&id, &evidence(&self.env));
        id
    }

    fn state(&self, id: &BytesN<32>) -> TaskState {
        self.escrow.get_task(id).state
    }

    fn balance(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    fn set_time(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }

    /// Asserts the last invocation required exactly `signer`'s authorization
    /// for `function` on the escrow contract.
    fn assert_signed_by(&self, signer: &Address, function: &str) {
        let auths = self.env.auths();
        assert_eq!(auths.len(), 1, "expected one authorizer for {function}");
        assert_eq!(&auths[0].0, signer, "wrong authorizer for {function}");
        match &auths[0].1.function {
            AuthorizedFunction::Contract((contract, name, _)) => {
                assert_eq!(contract, &self.escrow.address);
                assert_eq!(name, &Symbol::new(&self.env, function));
            }
            _ => panic!("expected a contract authorization"),
        }
    }

    /// Mocks a signature from `signer` only, for one call to `function`.
    fn only_signer(&self, signer: &Address, function: &'static str, args: Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &self.escrow.address,
                fn_name: function,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

// ----- Funding ---------------------------------------------------------------

#[test]
fn fund_escrows_tokens_and_requires_client_signature() {
    let s = setup();
    let before = s.balance(&s.client);
    let id = s.fund(1);

    let auths = s.env.auths();
    assert_eq!(auths[0].0, s.client);
    assert_eq!(s.balance(&s.client), before - AMOUNT);
    assert_eq!(s.balance(&s.escrow.address), AMOUNT);

    let task = s.escrow.get_task(&id);
    assert_eq!(task.state, TaskState::Funded);
    assert_eq!(task.amount, AMOUNT);
    assert_eq!(task.arbiter, s.arbiter);
    assert_eq!(task.review_window, REVIEW);
    assert_eq!(task.payee, None);
}

#[test]
fn fund_rejects_duplicate_task_id() {
    let s = setup();
    let id = s.fund(1);
    let res = s
        .escrow
        .try_fund(&id, &s.client, &s.token.address, &AMOUNT, &DEADLINE);
    assert_eq!(res, Err(Ok(Error::TaskExists)));
    assert_eq!(s.balance(&s.escrow.address), AMOUNT);
}

#[test]
fn fund_rejects_reuse_of_a_finished_task_id() {
    let s = setup();
    let id = s.fund(1);
    s.escrow.refund(&id);
    let res = s
        .escrow
        .try_fund(&id, &s.client, &s.token.address, &AMOUNT, &DEADLINE);
    assert_eq!(res, Err(Ok(Error::TaskExists)));
}

#[test]
fn fund_rejects_bad_amounts() {
    let s = setup();
    for amount in [0i128, -1, i128::MIN] {
        let res = s.escrow.try_fund(
            &tid(&s.env, 1),
            &s.client,
            &s.token.address,
            &amount,
            &DEADLINE,
        );
        assert_eq!(res, Err(Ok(Error::InvalidAmount)));
    }
}

#[test]
fn fund_rejects_token_not_on_allowlist() {
    let s = setup();
    let res = s.escrow.try_fund(
        &tid(&s.env, 1),
        &s.client,
        &s.other_token,
        &AMOUNT,
        &DEADLINE,
    );
    assert_eq!(res, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn fund_rejects_bad_deadlines() {
    let s = setup();
    for deadline in [START - 1, START, START + MAX_DEADLINE_SECS + 1] {
        let res = s.escrow.try_fund(
            &tid(&s.env, 1),
            &s.client,
            &s.token.address,
            &AMOUNT,
            &deadline,
        );
        assert_eq!(res, Err(Ok(Error::InvalidDeadline)), "deadline {deadline}");
    }
    // The maximum horizon itself is allowed.
    s.escrow.fund(
        &tid(&s.env, 2),
        &s.client,
        &s.token.address,
        &AMOUNT,
        &(START + MAX_DEADLINE_SECS),
    );
}

#[test]
fn fund_fails_when_someone_else_signs() {
    let s = setup();
    let id = tid(&s.env, 1);
    let args = (
        id.clone(),
        s.client.clone(),
        s.token.address.clone(),
        AMOUNT,
        DEADLINE,
    )
        .into_val(&s.env);
    s.only_signer(&s.stranger, "fund", args);
    let res = s
        .escrow
        .try_fund(&id, &s.client, &s.token.address, &AMOUNT, &DEADLINE);
    assert!(res.is_err());
    assert_eq!(s.balance(&s.escrow.address), 0);
}

#[test]
fn unknown_task_is_reported() {
    let s = setup();
    assert_eq!(
        s.escrow.try_get_task(&tid(&s.env, 9)),
        Err(Ok(Error::TaskNotFound))
    );
    assert_eq!(
        s.escrow.try_approve(&tid(&s.env, 9)),
        Err(Ok(Error::TaskNotFound))
    );
}

// ----- Happy path ------------------------------------------------------------

#[test]
fn assign_submit_approve_pays_exact_amount_to_payee() {
    let s = setup();
    let id = s.fund(1);

    s.escrow.assign(&id, &s.agent);
    s.assert_signed_by(&s.client, "assign");
    assert_eq!(s.state(&id), TaskState::Assigned);

    s.escrow.submit(&id, &evidence(&s.env));
    s.assert_signed_by(&s.agent, "submit");
    let task = s.escrow.get_task(&id);
    assert_eq!(task.state, TaskState::Submitted);
    assert_eq!(task.evidence, Some(evidence(&s.env)));
    assert_eq!(task.submitted_at, START);

    s.escrow.approve(&id);
    s.assert_signed_by(&s.client, "approve");
    assert_eq!(s.state(&id), TaskState::Released);
    assert_eq!(s.balance(&s.agent), AMOUNT);
    assert_eq!(s.balance(&s.escrow.address), 0);
}

#[test]
fn second_approve_is_rejected_and_pays_nothing() {
    let s = setup();
    let id = s.submitted(1);
    s.escrow.approve(&id);
    assert_eq!(s.escrow.try_approve(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.escrow.try_claim(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.balance(&s.agent), AMOUNT);
}

#[test]
fn tasks_are_isolated_from_each_other() {
    let s = setup();
    let a = s.submitted(1);
    let b = s.fund(2);
    s.escrow.approve(&a);
    assert_eq!(s.balance(&s.escrow.address), AMOUNT);
    assert_eq!(s.state(&b), TaskState::Funded);
}

// ----- Authorization -------------------------------------------------------

#[test]
fn approve_fails_for_payee_or_stranger() {
    let s = setup();
    let id = s.submitted(1);
    for signer in [&s.agent, &s.stranger] {
        s.only_signer(signer, "approve", (id.clone(),).into_val(&s.env));
        assert!(s.escrow.try_approve(&id).is_err());
    }
    s.env.mock_all_auths();
    assert_eq!(s.state(&id), TaskState::Submitted);
    assert_eq!(s.balance(&s.agent), 0);
}

#[test]
fn assign_fails_for_non_client() {
    let s = setup();
    let id = s.fund(1);
    s.only_signer(
        &s.agent,
        "assign",
        (id.clone(), s.agent.clone()).into_val(&s.env),
    );
    assert!(s.escrow.try_assign(&id, &s.agent).is_err());
    s.env.mock_all_auths();
    assert_eq!(s.state(&id), TaskState::Funded);
}

#[test]
fn submit_fails_for_non_payee() {
    let s = setup();
    let id = s.assigned(1);
    for signer in [&s.client, &s.stranger] {
        s.only_signer(
            signer,
            "submit",
            (id.clone(), evidence(&s.env)).into_val(&s.env),
        );
        assert!(s.escrow.try_submit(&id, &evidence(&s.env)).is_err());
    }
    s.env.mock_all_auths();
    assert_eq!(s.state(&id), TaskState::Assigned);
}

#[test]
fn refund_fails_for_non_client() {
    let s = setup();
    let id = s.fund(1);
    s.only_signer(&s.stranger, "refund", (id.clone(),).into_val(&s.env));
    assert!(s.escrow.try_refund(&id).is_err());
    s.env.mock_all_auths();
    assert_eq!(s.balance(&s.escrow.address), AMOUNT);
}

#[test]
fn claim_fails_for_client_or_stranger() {
    let s = setup();
    let id = s.submitted(1);
    s.set_time(START + REVIEW);
    for signer in [&s.client, &s.stranger] {
        s.only_signer(signer, "claim", (id.clone(),).into_val(&s.env));
        assert!(s.escrow.try_claim(&id).is_err());
    }
    s.env.mock_all_auths();
    assert_eq!(s.balance(&s.agent), 0);
}

// ----- State and timing rules --------------------------------------------

#[test]
fn approve_requires_a_submission() {
    let s = setup();
    let id = s.fund(1);
    assert_eq!(s.escrow.try_approve(&id), Err(Ok(Error::InvalidState)));
    s.escrow.assign(&id, &s.agent);
    assert_eq!(s.escrow.try_approve(&id), Err(Ok(Error::InvalidState)));
}

#[test]
fn assign_rules() {
    let s = setup();
    let id = s.fund(1);
    assert_eq!(
        s.escrow.try_assign(&id, &s.client),
        Err(Ok(Error::InvalidPayee))
    );
    s.set_time(DEADLINE);
    assert_eq!(
        s.escrow.try_assign(&id, &s.agent),
        Err(Ok(Error::DeadlinePassed))
    );
    s.set_time(START);
    s.escrow.assign(&id, &s.agent);
    assert_eq!(
        s.escrow.try_assign(&id, &s.stranger),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn submit_is_allowed_until_the_deadline_inclusive() {
    let s = setup();
    let id = s.assigned(1);
    s.set_time(DEADLINE + 1);
    assert_eq!(
        s.escrow.try_submit(&id, &evidence(&s.env)),
        Err(Ok(Error::DeadlinePassed))
    );
    s.set_time(DEADLINE);
    s.escrow.submit(&id, &evidence(&s.env));
    assert_eq!(s.state(&id), TaskState::Submitted);
}

#[test]
fn reject_then_resubmit_then_approve() {
    let s = setup();
    let id = s.submitted(1);
    s.escrow.reject(&id);
    s.assert_signed_by(&s.client, "reject");
    let task = s.escrow.get_task(&id);
    assert_eq!(task.state, TaskState::Assigned);
    assert_eq!(task.rejections, 1);
    assert_eq!(task.evidence, None);

    s.escrow
        .submit(&id, &BytesN::from_array(&s.env, &[0xab; 32]));
    s.escrow.approve(&id);
    assert_eq!(s.balance(&s.agent), AMOUNT);
}

#[test]
fn reject_must_happen_within_the_review_window() {
    let s = setup();
    let id = s.submitted(1);
    s.set_time(START + REVIEW);
    assert_eq!(s.escrow.try_reject(&id), Err(Ok(Error::ReviewWindowClosed)));
}

#[test]
fn claim_only_after_review_window() {
    let s = setup();
    let id = s.submitted(1);
    s.set_time(START + REVIEW - 1);
    assert_eq!(s.escrow.try_claim(&id), Err(Ok(Error::ReviewWindowOpen)));
    s.set_time(START + REVIEW);
    s.escrow.claim(&id);
    s.assert_signed_by(&s.agent, "claim");
    assert_eq!(s.state(&id), TaskState::Released);
    assert_eq!(s.balance(&s.agent), AMOUNT);
    assert_eq!(s.escrow.try_claim(&id), Err(Ok(Error::InvalidState)));
}

#[test]
fn review_window_change_does_not_affect_funded_tasks() {
    let s = setup();
    let id = s.submitted(1);
    s.escrow.set_review_window(&(REVIEW * 10));
    s.assert_signed_by(&s.admin, "set_review_window");
    s.set_time(START + REVIEW);
    s.escrow.claim(&id);
    assert_eq!(s.balance(&s.agent), AMOUNT);
}

// ----- Refunds ---------------------------------------------------------------

#[test]
fn refund_while_unassigned_returns_full_amount() {
    let s = setup();
    let before = s.balance(&s.client);
    let id = s.fund(1);
    s.escrow.refund(&id);
    s.assert_signed_by(&s.client, "refund");
    assert_eq!(s.state(&id), TaskState::Refunded);
    assert_eq!(s.balance(&s.client), before);
    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.balance(&s.client), before);
}

#[test]
fn refund_of_assigned_task_waits_for_deadline() {
    let s = setup();
    let id = s.assigned(1);
    s.set_time(DEADLINE);
    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::DeadlineNotPassed)));
    s.set_time(DEADLINE + 1);
    s.escrow.refund(&id);
    assert_eq!(s.state(&id), TaskState::Refunded);
}

#[test]
fn refund_is_blocked_while_a_submission_is_pending() {
    let s = setup();
    let id = s.submitted(1);
    s.set_time(DEADLINE + REVIEW * 2);
    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::InvalidState)));
}

#[test]
fn after_a_late_rejection_payee_gets_a_window_to_dispute() {
    let s = setup();
    let id = s.assigned(1);
    // Submit right at the deadline; client rejects shortly after it.
    s.set_time(DEADLINE);
    s.escrow.submit(&id, &evidence(&s.env));
    s.set_time(DEADLINE + 10);
    s.escrow.reject(&id);

    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::ReviewWindowOpen)));
    s.escrow.dispute(&id, &s.agent);
    assert_eq!(s.state(&id), TaskState::Disputed);
}

#[test]
fn refund_after_rejection_window_expires() {
    let s = setup();
    let id = s.submitted(1);
    s.set_time(START + 10);
    s.escrow.reject(&id);
    s.set_time(DEADLINE + 1);
    s.escrow.refund(&id);
    assert_eq!(s.state(&id), TaskState::Refunded);
}

#[test]
fn abandon_returns_task_to_funded_for_reassignment_or_refund() {
    let s = setup();
    let id = s.submitted(1);
    s.escrow.abandon(&id);
    s.assert_signed_by(&s.agent, "abandon");
    let task = s.escrow.get_task(&id);
    assert_eq!(task.state, TaskState::Funded);
    assert_eq!(task.payee, None);
    s.escrow.refund(&id);
    assert_eq!(s.balance(&s.escrow.address), 0);
}

// ----- Disputes --------------------------------------------------------------

#[test]
fn dispute_only_by_a_party_and_in_an_active_state() {
    let s = setup();
    let id = s.fund(1);
    assert_eq!(
        s.escrow.try_dispute(&id, &s.client),
        Err(Ok(Error::InvalidState))
    );
    s.escrow.assign(&id, &s.agent);
    assert_eq!(
        s.escrow.try_dispute(&id, &s.stranger),
        Err(Ok(Error::NotParty))
    );
    s.escrow.dispute(&id, &s.client);
    s.assert_signed_by(&s.client, "dispute");
    assert_eq!(s.state(&id), TaskState::Disputed);
}

#[test]
fn dispute_requires_the_disputer_signature() {
    let s = setup();
    let id = s.assigned(1);
    s.only_signer(
        &s.client,
        "dispute",
        (id.clone(), s.agent.clone()).into_val(&s.env),
    );
    assert!(s.escrow.try_dispute(&id, &s.agent).is_err());
    s.env.mock_all_auths();
    assert_eq!(s.state(&id), TaskState::Assigned);
}

#[test]
fn disputed_funds_are_frozen_until_resolved() {
    let s = setup();
    let id = s.submitted(1);
    s.escrow.dispute(&id, &s.agent);
    s.set_time(DEADLINE + REVIEW * 2);
    assert_eq!(s.escrow.try_approve(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.escrow.try_claim(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.escrow.try_refund(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.escrow.try_abandon(&id), Err(Ok(Error::InvalidState)));
    assert_eq!(s.balance(&s.escrow.address), AMOUNT);
}

#[test]
fn resolve_splits_exactly_with_no_rounding_loss() {
    let s = setup();
    let odd: i128 = 1_000_003;
    let id = tid(&s.env, 1);
    s.escrow
        .fund(&id, &s.client, &s.token.address, &odd, &DEADLINE);
    s.escrow.assign(&id, &s.agent);
    s.escrow.dispute(&id, &s.client);
    let client_before = s.balance(&s.client);

    s.escrow.resolve(&id, &3_333);
    s.assert_signed_by(&s.arbiter, "resolve");
    let payee_amount = odd * 3_333 / 10_000;
    assert_eq!(s.balance(&s.agent), payee_amount);
    assert_eq!(s.balance(&s.client), client_before + odd - payee_amount);
    assert_eq!(s.balance(&s.escrow.address), 0);
    assert_eq!(s.state(&id), TaskState::Resolved);
    assert_eq!(
        s.escrow.try_resolve(&id, &10_000),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn resolve_extremes_pay_one_side_fully() {
    let s = setup();
    let a = s.assigned(1);
    s.escrow.dispute(&a, &s.agent);
    s.escrow.resolve(&a, &10_000);
    assert_eq!(s.balance(&s.agent), AMOUNT);

    let b = s.assigned(2);
    s.escrow.dispute(&b, &s.agent);
    let client_before = s.balance(&s.client);
    s.escrow.resolve(&b, &0);
    assert_eq!(s.balance(&s.client), client_before + AMOUNT);
    assert_eq!(s.balance(&s.agent), AMOUNT);
}

#[test]
fn resolve_rejects_bps_over_100_percent() {
    let s = setup();
    let id = s.assigned(1);
    s.escrow.dispute(&id, &s.client);
    assert_eq!(
        s.escrow.try_resolve(&id, &10_001),
        Err(Ok(Error::InvalidBps))
    );
}

#[test]
fn only_the_tasks_arbiter_can_resolve() {
    let s = setup();
    let id = s.assigned(1);
    s.escrow.dispute(&id, &s.client);
    for signer in [&s.client, &s.agent, &s.admin] {
        s.only_signer(signer, "resolve", (id.clone(), 10_000u32).into_val(&s.env));
        assert!(s.escrow.try_resolve(&id, &10_000).is_err());
    }
    s.env.mock_all_auths();
    assert_eq!(s.state(&id), TaskState::Disputed);
}

#[test]
fn changing_the_arbiter_does_not_affect_funded_tasks() {
    let s = setup();
    let id = s.assigned(1);
    let new_arbiter = Address::generate(&s.env);
    s.escrow.set_arbiter(&new_arbiter);
    s.assert_signed_by(&s.admin, "set_arbiter");
    s.escrow.dispute(&id, &s.client);

    s.only_signer(&new_arbiter, "resolve", (id.clone(), 0u32).into_val(&s.env));
    assert!(s.escrow.try_resolve(&id, &0).is_err());
    s.env.mock_all_auths();
    s.escrow.resolve(&id, &0);
    s.assert_signed_by(&s.arbiter, "resolve");

    // New tasks use the new arbiter.
    let next = s.fund(2);
    assert_eq!(s.escrow.get_task(&next).arbiter, new_arbiter);
}

// ----- Admin -----------------------------------------------------------------

#[test]
fn admin_functions_require_admin() {
    let s = setup();
    s.only_signer(
        &s.stranger,
        "set_arbiter",
        (s.stranger.clone(),).into_val(&s.env),
    );
    assert!(s.escrow.try_set_arbiter(&s.stranger).is_err());
    s.only_signer(
        &s.stranger,
        "set_token_allowed",
        (s.other_token.clone(), true).into_val(&s.env),
    );
    assert!(s
        .escrow
        .try_set_token_allowed(&s.other_token, &true)
        .is_err());
    s.env.mock_all_auths();
    assert_eq!(s.escrow.get_config().arbiter, s.arbiter);
    assert!(!s.escrow.is_token_allowed(&s.other_token));
}

#[test]
fn token_allowlist_can_be_updated_by_admin() {
    let s = setup();
    s.escrow.set_token_allowed(&s.other_token, &true);
    s.escrow.fund(
        &tid(&s.env, 1),
        &s.client,
        &s.other_token,
        &AMOUNT,
        &DEADLINE,
    );
    s.escrow.set_token_allowed(&s.other_token, &false);
    assert_eq!(
        s.escrow.try_fund(
            &tid(&s.env, 2),
            &s.client,
            &s.other_token,
            &AMOUNT,
            &DEADLINE
        ),
        Err(Ok(Error::TokenNotAllowed))
    );
}

#[test]
fn review_window_bounds_are_enforced() {
    let s = setup();
    assert_eq!(
        s.escrow.try_set_review_window(&0),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(
        s.escrow
            .try_set_review_window(&(MAX_REVIEW_WINDOW_SECS + 1)),
        Err(Ok(Error::InvalidConfig))
    );
}

#[test]
fn bump_extends_existing_tasks_only() {
    let s = setup();
    let id = s.fund(1);
    s.escrow.bump(&id);
    assert_eq!(
        s.escrow.try_bump(&tid(&s.env, 9)),
        Err(Ok(Error::TaskNotFound))
    );
}
