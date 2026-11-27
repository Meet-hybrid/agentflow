//! Randomised property tests (proptest).
//!
//! The hand-written suite in `test.rs` pins behaviour on chosen values and
//! boundaries. This suite tries to break the contract's money claims with
//! generated inputs. It checks four properties against a real Stellar Asset
//! Contract, so every balance is real token movement:
//!
//! **P1, conservation on every terminal path.** For random amounts, deadlines,
//! review windows, rejection counts and arbiter splits, each way a task can
//! end (approve, claim after timeout, refund before assignment, refund after
//! the deadline, dispute and resolve) leaves the contract holding zero for
//! that task, and the client's and payee's gains add up to exactly the
//! amount funded.
//!
//! **P2, exact model over arbitrary call sequences.** Random sequences of
//! every lifecycle call (fund, assign, submit, reject, approve, claim, abandon,
//! refund, dispute, resolve), across three task ids, three counterparties and
//! moving time, are run against a plain Rust model of the rules. After every
//! call:
//! - the call succeeds exactly when the model says it should, and fails with
//!   exactly the error the model predicts;
//! - every account's balance equals the model's, so no call creates, destroys
//!   or misdirects a single stroop;
//! - the contract's balance equals the sum of the amounts of tasks that have
//!   not ended, so a task that has ended can never pay out again;
//! - the stored task matches the model field by field.
//!
//! **P3, terms are fixed at funding.** Changing the arbiter or the review
//! window after a task is funded changes neither who resolves its dispute nor
//! the window its client and payee work to.
//!
//! **P4, time limits are exact.** For random deadlines, review windows and
//! submission times, each time limit (assign, submit, reject, claim, refund
//! after the deadline, refund after a rejection) refuses one second early and
//! allows exactly on time.
//!
//! Authorization is mocked here (`mock_all_auths`); `test.rs` checks who must
//! sign each call. Runs are deterministic: proptest uses a fixed seed unless
//! `PROPTEST_RNG_SEED` is set, and a failing case is shrunk and printed. Raise
//! the case count with `PROPTEST_CASES=2000 cargo test props`.

extern crate std;

use std::vec;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    token::{StellarAssetClient, TokenClient},
    InvokeError,
};

const START: u64 = 1_000_000;
const MAX_AMOUNT: i128 = 1_000_000_000_000_000;
const TASKS: usize = 3;

fn quiet_env() -> Env {
    // Proptest runs hundreds of cases per test; don't write a snapshot file
    // for each one.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(START);
    env
}

/// Collapses a `try_*` client result to the contract's own error, failing the
/// test on any host-level error (a trap, a failed transfer, a bad auth).
fn outcome<T, C: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<Error, InvokeError>>,
) -> Result<(), Error> {
    match r {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => panic!("conversion error: {e:?}"),
        Err(Ok(e)) => Err(e),
        Err(Err(e)) => panic!("host error, not a contract error: {e:?}"),
    }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/// Accounts tracked by the model. `Client` funds every task; `PayeeA` and
/// `PayeeB` are agents; `Outsider` is never a party.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum Who {
    Client = 0,
    PayeeA = 1,
    PayeeB = 2,
    Outsider = 3,
}

struct World {
    env: Env,
    escrow: TaskEscrowClient<'static>,
    token: TokenClient<'static>,
    arbiter: Address,
    accounts: [Address; 4],
}

impl World {
    fn new(review_window: u64, client_balance: i128) -> Self {
        let env = quiet_env();
        let issuer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        let admin = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let id = env.register(
            TaskEscrow,
            (
                admin,
                arbiter.clone(),
                review_window,
                soroban_sdk::vec![&env, sac.address()],
            ),
        );
        let accounts = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        StellarAssetClient::new(&env, &sac.address()).mint(&accounts[0], &client_balance);
        World {
            escrow: TaskEscrowClient::new(&env, &id),
            token: TokenClient::new(&env, &sac.address()),
            arbiter,
            accounts,
            env,
        }
    }

    fn addr(&self, who: Who) -> &Address {
        &self.accounts[who as usize]
    }

    fn balance(&self, who: Who) -> i128 {
        self.token.balance(self.addr(who))
    }

    fn held(&self) -> i128 {
        self.token.balance(&self.escrow.address)
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().set_timestamp(self.now() + secs);
    }

    fn tid(&self, n: usize) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n as u8 + 1; 32])
    }

    fn evidence(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
}

// ---------------------------------------------------------------------------
// P1: conservation on every terminal path
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug)]
enum Ending {
    Approve,
    Claim,
    RefundUnassigned,
    RefundAfterDeadline,
    Resolve { by_payee: bool, bps: u32 },
}

fn ending() -> impl Strategy<Value = Ending> {
    prop_oneof![
        Just(Ending::Approve),
        Just(Ending::Claim),
        Just(Ending::RefundUnassigned),
        Just(Ending::RefundAfterDeadline),
        (any::<bool>(), 0u32..=BPS_DENOMINATOR)
            .prop_map(|(by_payee, bps)| Ending::Resolve { by_payee, bps }),
        // The split boundaries, so they are hit on every run.
        Just(Ending::Resolve {
            by_payee: true,
            bps: 0
        }),
        Just(Ending::Resolve {
            by_payee: false,
            bps: BPS_DENOMINATOR
        }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn p1_every_ending_conserves_the_escrow(
        amount in 1i128..=MAX_AMOUNT,
        extra in 0i128..=MAX_AMOUNT,
        window in MIN_REVIEW_WINDOW_SECS..=7 * 24 * 3600,
        deadline_in in 1u64..=MAX_DEADLINE_SECS,
        rejections in 0u32..=3,
        end in ending(),
    ) {
        let w = World::new(window, amount + extra);
        let id = w.tid(0);
        let client = w.addr(Who::Client).clone();
        let payee = w.addr(Who::PayeeA).clone();
        let deadline = START + deadline_in;

        w.escrow.fund(&id, &client, &w.token.address, &amount, &deadline);
        prop_assert_eq!(w.held(), amount);
        prop_assert_eq!(w.balance(Who::Client), extra);

        match end {
            Ending::RefundUnassigned => w.escrow.refund(&id),
            _ => {
                w.escrow.assign(&id, &payee);
                // Rejections happen before the deadline, so a submission is
                // always possible; only the last one is kept.
                for r in 0..rejections {
                    w.escrow.submit(&id, &w.evidence(r as u8));
                    w.escrow.reject(&id);
                }
                match end {
                    Ending::Approve => {
                        w.escrow.submit(&id, &w.evidence(0xaa));
                        w.escrow.approve(&id);
                    }
                    Ending::Claim => {
                        w.escrow.submit(&id, &w.evidence(0xaa));
                        w.advance(window);
                        w.escrow.claim(&id);
                    }
                    Ending::RefundAfterDeadline => {
                        // Past the deadline and past the window to dispute
                        // the last rejection, whichever is later.
                        w.env.ledger().set_timestamp(deadline + window + 1);
                        w.escrow.refund(&id);
                    }
                    Ending::Resolve { by_payee, bps } => {
                        if by_payee {
                            w.escrow.submit(&id, &w.evidence(0xaa));
                        }
                        w.escrow.dispute(&id, if by_payee { &payee } else { &client });
                        w.escrow.resolve(&id, &bps);
                    }
                    Ending::RefundUnassigned => unreachable!(),
                }
            }
        }

        let payee_gain = w.balance(Who::PayeeA);
        let client_gain = w.balance(Who::Client) - extra;
        prop_assert_eq!(w.held(), 0, "contract must end holding nothing");
        prop_assert_eq!(payee_gain + client_gain, amount, "gains must equal the escrow");
        prop_assert!(payee_gain >= 0 && client_gain >= 0);
        let expected_payee = match end {
            Ending::Approve | Ending::Claim => amount,
            Ending::RefundUnassigned | Ending::RefundAfterDeadline => 0,
            Ending::Resolve { bps, .. } => amount * bps as i128 / BPS_DENOMINATOR as i128,
        };
        prop_assert_eq!(payee_gain, expected_payee);

        // Ended means ended: no second payout by any route.
        let id = w.tid(0);
        prop_assert!(w.escrow.try_approve(&id).is_err());
        prop_assert!(w.escrow.try_claim(&id).is_err());
        prop_assert!(w.escrow.try_refund(&id).is_err());
        prop_assert!(w.escrow.try_resolve(&id, &0).is_err());
        prop_assert_eq!(w.held(), 0);
    }
}

// ---------------------------------------------------------------------------
// P2: exact model over arbitrary call sequences
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Fund {
        task: usize,
        amount: i128,
        deadline_in: u64,
    },
    Assign {
        task: usize,
        to: Who,
    },
    Submit {
        task: usize,
    },
    Reject {
        task: usize,
    },
    Approve {
        task: usize,
    },
    Claim {
        task: usize,
    },
    Abandon {
        task: usize,
    },
    Refund {
        task: usize,
    },
    Dispute {
        task: usize,
        by: Who,
    },
    Resolve {
        task: usize,
        bps: u32,
    },
    SetReviewWindow {
        secs: u64,
    },
    Advance {
        secs: u64,
    },
    /// Jump to (or one second before) one of a task's time edges, so the
    /// boundary checks are exercised exactly rather than by luck.
    AdvanceToEdge {
        task: usize,
        edge: Edge,
        early: bool,
    },
}

#[derive(Copy, Clone, Debug)]
enum Edge {
    Deadline,
    ReviewEnds,
    DisputeWindowEnds,
}

fn who() -> impl Strategy<Value = Who> {
    prop_oneof![
        Just(Who::Client),
        Just(Who::PayeeA),
        Just(Who::PayeeB),
        Just(Who::Outsider),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    // Most calls go to one task so long lifecycles (fund, assign, submit,
    // reject, resubmit, timeout) actually happen; the others check that
    // tasks don't interfere.
    let task = prop_oneof![6 => Just(0usize), 3 => Just(1usize), 1 => Just(2usize)];
    prop_oneof![
        3 => (
            task.clone(),
            prop_oneof![1 => -5i128..=0, 9 => 1i128..=MAX_AMOUNT],
            prop_oneof![
                1 => Just(0u64),
                8 => 1u64..=200_000,
                1 => MAX_DEADLINE_SECS - 2..=MAX_DEADLINE_SECS + 2,
            ],
        )
            .prop_map(|(task, amount, deadline_in)| Op::Fund { task, amount, deadline_in }),
        // Assigning the client must fail; the outsider is never assigned, so
        // it stays a non-party for disputes.
        3 => (
            task.clone(),
            prop_oneof![1 => Just(Who::Client), 3 => Just(Who::PayeeA), 2 => Just(Who::PayeeB)],
        )
            .prop_map(|(task, to)| Op::Assign { task, to }),
        3 => task.clone().prop_map(|task| Op::Submit { task }),
        2 => task.clone().prop_map(|task| Op::Reject { task }),
        2 => task.clone().prop_map(|task| Op::Approve { task }),
        2 => task.clone().prop_map(|task| Op::Claim { task }),
        1 => task.clone().prop_map(|task| Op::Abandon { task }),
        2 => task.clone().prop_map(|task| Op::Refund { task }),
        2 => (task.clone(), who()).prop_map(|(task, by)| Op::Dispute { task, by }),
        2 => (
            task.clone(),
            prop_oneof![9 => 0u32..=BPS_DENOMINATOR, 1 => BPS_DENOMINATOR + 1..=u32::MAX],
        )
            .prop_map(|(task, bps)| Op::Resolve { task, bps }),
        1 => prop_oneof![
            1 => MIN_REVIEW_WINDOW_SECS - 1..=MIN_REVIEW_WINDOW_SECS,
            8 => MIN_REVIEW_WINDOW_SECS..=7200,
            1 => MAX_REVIEW_WINDOW_SECS..=MAX_REVIEW_WINDOW_SECS + 1,
        ]
        .prop_map(|secs| Op::SetReviewWindow { secs }),
        3 => prop_oneof![
            1u64..=30,
            30u64..=4_000,
            50_000u64..=250_000,
        ]
        .prop_map(|secs| Op::Advance { secs }),
        4 => (
            task,
            prop_oneof![Just(Edge::Deadline), Just(Edge::ReviewEnds), Just(Edge::DisputeWindowEnds)],
            any::<bool>(),
        )
            .prop_map(|(task, edge, early)| Op::AdvanceToEdge { task, edge, early }),
    ]
}

/// The model's view of one task.
#[derive(Clone, Debug)]
struct MTask {
    amount: i128,
    deadline: u64,
    window: u64,
    payee: Option<Who>,
    evidence: Option<u8>,
    submitted_at: u64,
    rejections: u32,
    rejected_at: u64,
    state: TaskState,
}

fn ended(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Released | TaskState::Refunded | TaskState::Resolved
    )
}

struct Model {
    window: u64,
    tasks: [Option<MTask>; TASKS],
    balances: [i128; 4],
    held: i128,
}

impl Model {
    fn task(&self, n: usize) -> Result<&MTask, Error> {
        self.tasks[n].as_ref().ok_or(Error::TaskNotFound)
    }

    /// Seconds to advance for an `AdvanceToEdge`, or 0 when the edge is
    /// unknown or already behind us. `early` stops one second short.
    fn secs_to_edge(&self, task: usize, edge: Edge, early: bool, now: u64) -> u64 {
        let Some(t) = &self.tasks[task] else { return 0 };
        let at = match edge {
            Edge::Deadline => t.deadline,
            Edge::ReviewEnds if t.state == TaskState::Submitted => t.submitted_at + t.window,
            Edge::DisputeWindowEnds if t.rejections > 0 => t.rejected_at + t.window,
            _ => return 0,
        };
        let at = if early { at - 1 } else { at };
        at.saturating_sub(now)
    }

    fn pay(&mut self, to: Who, amount: i128) {
        self.held -= amount;
        self.balances[to as usize] += amount;
    }

    /// Predicts the result of `op` and, when it succeeds, applies it. The
    /// checks mirror the contract's, in the contract's order, so the
    /// predicted error is exact.
    fn apply(&mut self, op: &Op, now: u64, step: u8) -> Result<(), Error> {
        match *op {
            Op::Fund {
                task,
                amount,
                deadline_in,
            } => {
                if amount <= 0 {
                    return Err(Error::InvalidAmount);
                }
                if deadline_in == 0 || deadline_in > MAX_DEADLINE_SECS {
                    return Err(Error::InvalidDeadline);
                }
                if self.tasks[task].is_some() {
                    return Err(Error::TaskExists);
                }
                self.tasks[task] = Some(MTask {
                    amount,
                    deadline: now + deadline_in,
                    window: self.window,
                    payee: None,
                    evidence: None,
                    submitted_at: 0,
                    rejections: 0,
                    rejected_at: 0,
                    state: TaskState::Funded,
                });
                self.balances[Who::Client as usize] -= amount;
                self.held += amount;
                Ok(())
            }
            Op::Assign { task, to } => {
                let t = self.task(task)?;
                if t.state != TaskState::Funded {
                    return Err(Error::InvalidState);
                }
                if now >= t.deadline {
                    return Err(Error::DeadlinePassed);
                }
                if to == Who::Client {
                    return Err(Error::InvalidPayee);
                }
                let t = self.tasks[task].as_mut().unwrap();
                t.payee = Some(to);
                t.state = TaskState::Assigned;
                Ok(())
            }
            Op::Submit { task } => {
                let t = self.task(task)?;
                if t.payee.is_none() || t.state != TaskState::Assigned {
                    return Err(Error::InvalidState);
                }
                if now > t.deadline {
                    return Err(Error::DeadlinePassed);
                }
                let t = self.tasks[task].as_mut().unwrap();
                t.evidence = Some(step);
                t.submitted_at = now;
                t.state = TaskState::Submitted;
                Ok(())
            }
            Op::Reject { task } => {
                let t = self.task(task)?;
                if t.state != TaskState::Submitted {
                    return Err(Error::InvalidState);
                }
                if now >= t.submitted_at + t.window {
                    return Err(Error::ReviewWindowClosed);
                }
                let t = self.tasks[task].as_mut().unwrap();
                t.evidence = None;
                t.submitted_at = 0;
                t.rejections += 1;
                t.rejected_at = now;
                t.state = TaskState::Assigned;
                Ok(())
            }
            Op::Approve { task } => {
                let t = self.task(task)?;
                if t.state != TaskState::Submitted {
                    return Err(Error::InvalidState);
                }
                let (payee, amount) = (t.payee.unwrap(), t.amount);
                self.tasks[task].as_mut().unwrap().state = TaskState::Released;
                self.pay(payee, amount);
                Ok(())
            }
            Op::Claim { task } => {
                let t = self.task(task)?;
                if t.payee.is_none() || t.state != TaskState::Submitted {
                    return Err(Error::InvalidState);
                }
                if now < t.submitted_at + t.window {
                    return Err(Error::ReviewWindowOpen);
                }
                let (payee, amount) = (t.payee.unwrap(), t.amount);
                self.tasks[task].as_mut().unwrap().state = TaskState::Released;
                self.pay(payee, amount);
                Ok(())
            }
            Op::Abandon { task } => {
                let t = self.task(task)?;
                if t.payee.is_none()
                    || !matches!(t.state, TaskState::Assigned | TaskState::Submitted)
                {
                    return Err(Error::InvalidState);
                }
                let t = self.tasks[task].as_mut().unwrap();
                t.payee = None;
                t.evidence = None;
                t.submitted_at = 0;
                t.state = TaskState::Funded;
                Ok(())
            }
            Op::Refund { task } => {
                let t = self.task(task)?;
                match t.state {
                    TaskState::Funded => {}
                    TaskState::Assigned => {
                        if now <= t.deadline {
                            return Err(Error::DeadlineNotPassed);
                        }
                        if t.rejections > 0 && now < t.rejected_at + t.window {
                            return Err(Error::ReviewWindowOpen);
                        }
                    }
                    _ => return Err(Error::InvalidState),
                }
                let amount = t.amount;
                self.tasks[task].as_mut().unwrap().state = TaskState::Refunded;
                self.pay(Who::Client, amount);
                Ok(())
            }
            Op::Dispute { task, by } => {
                let t = self.task(task)?;
                if by != Who::Client && Some(by) != t.payee {
                    return Err(Error::NotParty);
                }
                if !matches!(t.state, TaskState::Assigned | TaskState::Submitted) {
                    return Err(Error::InvalidState);
                }
                self.tasks[task].as_mut().unwrap().state = TaskState::Disputed;
                Ok(())
            }
            Op::Resolve { task, bps } => {
                let t = self.task(task)?;
                if t.state != TaskState::Disputed {
                    return Err(Error::InvalidState);
                }
                if bps > BPS_DENOMINATOR {
                    return Err(Error::InvalidBps);
                }
                let payee = t.payee.unwrap();
                let to_payee = t.amount * bps as i128 / BPS_DENOMINATOR as i128;
                let to_client = t.amount - to_payee;
                self.tasks[task].as_mut().unwrap().state = TaskState::Resolved;
                self.pay(payee, to_payee);
                self.pay(Who::Client, to_client);
                Ok(())
            }
            Op::SetReviewWindow { secs } => {
                if !(MIN_REVIEW_WINDOW_SECS..=MAX_REVIEW_WINDOW_SECS).contains(&secs) {
                    return Err(Error::InvalidConfig);
                }
                self.window = secs;
                Ok(())
            }
            Op::Advance { .. } | Op::AdvanceToEdge { .. } => Ok(()),
        }
    }
}

fn run(w: &World, op: &Op, step: u8) -> Result<(), Error> {
    let e = &w.escrow;
    match *op {
        Op::Fund {
            task,
            amount,
            deadline_in,
        } => outcome(e.try_fund(
            &w.tid(task),
            w.addr(Who::Client),
            &w.token.address,
            &amount,
            &(w.now() + deadline_in),
        )),
        Op::Assign { task, to } => outcome(e.try_assign(&w.tid(task), w.addr(to))),
        Op::Submit { task } => outcome(e.try_submit(&w.tid(task), &w.evidence(step))),
        Op::Reject { task } => outcome(e.try_reject(&w.tid(task))),
        Op::Approve { task } => outcome(e.try_approve(&w.tid(task))),
        Op::Claim { task } => outcome(e.try_claim(&w.tid(task))),
        Op::Abandon { task } => outcome(e.try_abandon(&w.tid(task))),
        Op::Refund { task } => outcome(e.try_refund(&w.tid(task))),
        Op::Dispute { task, by } => outcome(e.try_dispute(&w.tid(task), w.addr(by))),
        Op::Resolve { task, bps } => outcome(e.try_resolve(&w.tid(task), &bps)),
        Op::SetReviewWindow { secs } => outcome(e.try_set_review_window(&secs)),
        Op::Advance { secs } => {
            w.advance(secs);
            Ok(())
        }
        Op::AdvanceToEdge { .. } => unreachable!("resolved to Advance by the caller"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn p2_random_sequences_match_the_model(
        window in MIN_REVIEW_WINDOW_SECS..=7200,
        ops in proptest::collection::vec(op(), 1..80),
    ) {
        // Enough for every possible fund, so a failed transfer never hides
        // a contract bug.
        let start_balance = MAX_AMOUNT * TASKS as i128;
        let w = World::new(window, start_balance);
        let mut m = Model {
            window,
            tasks: [None, None, None],
            balances: [start_balance, 0, 0, 0],
            held: 0,
        };
        let total = start_balance;

        for (i, op) in ops.iter().enumerate() {
            let step = (i % 250) as u8 + 1;
            let op = &match *op {
                Op::AdvanceToEdge { task, edge, early } => Op::Advance {
                    secs: m.secs_to_edge(task, edge, early, w.now()),
                },
                ref other => other.clone(),
            };
            let expected = m.apply(op, w.now(), step);
            let actual = run(&w, op, step);
            prop_assert_eq!(actual, expected, "step {}: {:?}", i, op);

            // Every balance is exactly what the model says.
            for who in [Who::Client, Who::PayeeA, Who::PayeeB, Who::Outsider] {
                prop_assert_eq!(w.balance(who), m.balances[who as usize], "step {}: {:?} balance", i, who);
            }
            prop_assert_eq!(w.held(), m.held, "step {}: contract balance", i);
            prop_assert_eq!(w.balance(Who::Outsider), 0);
            prop_assert_eq!(w.token.balance(&w.arbiter), 0, "the arbiter is never paid");

            // Conservation, and the contract holds exactly the open tasks.
            let parties: i128 = m.balances.iter().sum();
            prop_assert_eq!(parties + w.held(), total, "step {}: value created or destroyed", i);
            let open: i128 = m.tasks.iter().flatten()
                .filter(|t| !ended(t.state))
                .map(|t| t.amount)
                .sum();
            prop_assert_eq!(w.held(), open, "step {}: held != open escrows", i);

            // The stored task matches the model field by field.
            for (n, mt) in m.tasks.iter().enumerate() {
                match mt {
                    None => prop_assert_eq!(
                        outcome(w.escrow.try_get_task(&w.tid(n))),
                        Err(Error::TaskNotFound)
                    ),
                    Some(mt) => {
                        let t = w.escrow.get_task(&w.tid(n));
                        prop_assert_eq!(t.state, mt.state);
                        prop_assert_eq!(t.amount, mt.amount);
                        prop_assert_eq!(t.deadline, mt.deadline);
                        prop_assert_eq!(t.review_window, mt.window);
                        prop_assert_eq!(t.payee, mt.payee.map(|p| w.addr(p).clone()));
                        prop_assert_eq!(t.evidence, mt.evidence.map(|e| w.evidence(e)));
                        prop_assert_eq!(t.submitted_at, mt.submitted_at);
                        prop_assert_eq!(t.rejections, mt.rejections);
                        prop_assert_eq!(t.rejected_at, mt.rejected_at);
                        prop_assert_eq!(&t.arbiter, &w.arbiter);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// P3: terms are fixed at funding
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn p3_later_config_changes_do_not_touch_funded_tasks(
        amount in 1i128..=MAX_AMOUNT,
        window in MIN_REVIEW_WINDOW_SECS..=7200,
        new_window in MIN_REVIEW_WINDOW_SECS..=MAX_REVIEW_WINDOW_SECS,
        bps in 0u32..=BPS_DENOMINATOR,
    ) {
        let w = World::new(window, amount);
        let id = w.tid(0);
        let payee = w.addr(Who::PayeeA).clone();
        w.escrow.fund(&id, w.addr(Who::Client), &w.token.address, &amount, &(START + 86_400));
        w.escrow.assign(&id, &payee);
        w.escrow.submit(&id, &w.evidence(1));

        let new_arbiter = Address::generate(&w.env);
        w.escrow.set_arbiter(&new_arbiter);
        w.escrow.set_review_window(&new_window);

        let t = w.escrow.get_task(&id);
        prop_assert_eq!(&t.arbiter, &w.arbiter);
        prop_assert_eq!(t.review_window, window);

        // The claim opens on the funded window, not the new one.
        w.advance(window - 1);
        prop_assert_eq!(outcome(w.escrow.try_claim(&id)), Err(Error::ReviewWindowOpen));
        w.advance(1);
        w.escrow.dispute(&id, w.addr(Who::Client));

        // Only the arbiter fixed at funding may resolve: its address is the one
        // `resolve` requires.
        w.escrow.resolve(&id, &bps);
        let auths = w.env.auths();
        prop_assert_eq!(auths.len(), 1);
        prop_assert_eq!(&auths[0].0, &w.arbiter);
        prop_assert_eq!(w.held(), 0);
    }
}

// ---------------------------------------------------------------------------
// P4: every time limit is exact
// ---------------------------------------------------------------------------

/// A world with task 0 funded by the client, deadline `deadline_in` seconds
/// from now, assigned to PayeeA when `assign` is set.
fn funded(window: u64, deadline_in: u64, assign: bool) -> (World, BytesN<32>, u64) {
    let w = World::new(window, 1_000);
    let id = w.tid(0);
    let deadline = START + deadline_in;
    w.escrow.fund(
        &id,
        w.addr(Who::Client),
        &w.token.address,
        &1_000,
        &deadline,
    );
    if assign {
        w.escrow.assign(&id, w.addr(Who::PayeeA));
    }
    (w, id, deadline)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// For random review windows, deadlines and submission times, each time
    /// limit refuses one second early (or late) and allows exactly on time.
    /// A shifted comparison (`<` for `<=`) in any of them fails this test.
    #[test]
    fn p4_time_limits_are_exact(
        window in MIN_REVIEW_WINDOW_SECS..=7 * 24 * 3600,
        deadline_in in 2u64..=MAX_DEADLINE_SECS,
        submit_frac in 0u64..=1_000,
    ) {
        let at = |w: &World, t: u64| w.env.ledger().set_timestamp(t);

        // assign: allowed until the second before the deadline.
        let (w, id, deadline) = funded(window, deadline_in, false);
        at(&w, deadline);
        prop_assert_eq!(outcome(w.escrow.try_assign(&id, w.addr(Who::PayeeA))), Err(Error::DeadlinePassed));
        let (w, id, deadline) = funded(window, deadline_in, false);
        at(&w, deadline - 1);
        prop_assert_eq!(outcome(w.escrow.try_assign(&id, w.addr(Who::PayeeA))), Ok(()));

        // submit: allowed at the deadline, refused one second after.
        let (w, id, deadline) = funded(window, deadline_in, true);
        at(&w, deadline + 1);
        prop_assert_eq!(outcome(w.escrow.try_submit(&id, &w.evidence(1))), Err(Error::DeadlinePassed));
        at(&w, deadline);
        prop_assert_eq!(outcome(w.escrow.try_submit(&id, &w.evidence(1))), Ok(()));

        // refund of assigned work: only once the deadline has passed.
        let (w, id, deadline) = funded(window, deadline_in, true);
        at(&w, deadline);
        prop_assert_eq!(outcome(w.escrow.try_refund(&id)), Err(Error::DeadlineNotPassed));
        at(&w, deadline + 1);
        prop_assert_eq!(outcome(w.escrow.try_refund(&id)), Ok(()));

        // A submission at a random point before the deadline.
        let submitted_at = START + (deadline_in - 1) * submit_frac / 1_000;

        // reject: inside the review window only; claim: from its end.
        let (w, id, _) = funded(window, deadline_in, true);
        at(&w, submitted_at);
        w.escrow.submit(&id, &w.evidence(1));
        at(&w, submitted_at + window - 1);
        prop_assert_eq!(outcome(w.escrow.try_claim(&id)), Err(Error::ReviewWindowOpen));
        prop_assert_eq!(outcome(w.escrow.try_reject(&id)), Ok(()));

        let (w, id, _) = funded(window, deadline_in, true);
        at(&w, submitted_at);
        w.escrow.submit(&id, &w.evidence(1));
        at(&w, submitted_at + window);
        prop_assert_eq!(outcome(w.escrow.try_reject(&id)), Err(Error::ReviewWindowClosed));
        prop_assert_eq!(outcome(w.escrow.try_claim(&id)), Ok(()));
        prop_assert_eq!(w.balance(Who::PayeeA), 1_000);

        // After a rejection the payee keeps one full window to dispute, even
        // past the deadline: refund opens exactly when that window ends.
        let (w, id, deadline) = funded(window, deadline_in, true);
        at(&w, submitted_at);
        w.escrow.submit(&id, &w.evidence(1));
        w.escrow.reject(&id);
        let opens = core::cmp::max(deadline + 1, submitted_at + window);
        at(&w, opens - 1);
        prop_assert!(outcome(w.escrow.try_refund(&id)).is_err());
        at(&w, opens);
        prop_assert_eq!(outcome(w.escrow.try_refund(&id)), Ok(()));
        prop_assert_eq!(w.balance(Who::Client), 1_000);
    }
}
