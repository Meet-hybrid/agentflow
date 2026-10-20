//! AgentFlow task escrow.
//!
//! Holds a client's bounty for one task and releases it only through the
//! paths below. The contract never judges whether work is correct; it only
//! enforces who may move the money and when.
//!
//! ```text
//!            fund (client)
//!   (none) ───────────────▶ Funded ──refund (client)──────────────▶ Refunded
//!                             │  ▲
//!              assign (client)│  │abandon (payee)
//!                             ▼  │
//!                           Assigned ──refund after deadline* (client)▶ Refunded
//!                             │  ▲
//!      submit (payee, ≤ deadline)│  │reject (client, within review window)
//!                             ▼  │
//!                           Submitted ──approve (client)────────────▶ Released
//!                                     ──claim after review window (payee)▶ Released
//!
//!   Assigned | Submitted ──dispute (client or payee)──▶ Disputed
//!   Disputed ──resolve(payee_bps) (task's arbiter)────▶ Resolved
//!
//!   * and, after a rejection, only once the payee has had one full review
//!     window to dispute it.
//! ```
//!
//! Authorization: every state change requires the signature of the party
//! named above (`require_auth`). The arbiter and review window are copied
//! into each task when it is funded, so the admin cannot change the rules
//! for money already in escrow. The admin can only change the arbiter,
//! review window and token allowlist for future tasks; it can never move
//! escrowed funds.
//!
//! Safety: each task id can be funded once (no replay), every payout moves
//! the task to a terminal state before transferring (no double payment), and
//! Soroban forbids re-entering a contract during its own execution.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

/// Basis points in 100%.
pub const BPS_DENOMINATOR: u32 = 10_000;
/// Longest allowed time between funding and the submission deadline.
pub const MAX_DEADLINE_SECS: u64 = 90 * 24 * 60 * 60;
/// Review window bounds (seconds).
pub const MIN_REVIEW_WINDOW_SECS: u64 = 60;
pub const MAX_REVIEW_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;

// Ledgers close roughly every 5 seconds.
const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TaskExists = 1,
    TaskNotFound = 2,
    InvalidAmount = 3,
    TokenNotAllowed = 4,
    InvalidDeadline = 5,
    InvalidState = 6,
    DeadlinePassed = 7,
    DeadlineNotPassed = 8,
    ReviewWindowOpen = 9,
    InvalidBps = 10,
    NotParty = 11,
    InvalidPayee = 12,
    InvalidConfig = 13,
    ReviewWindowClosed = 14,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TaskState {
    Funded = 0,
    Assigned = 1,
    Submitted = 2,
    Released = 3,
    Refunded = 4,
    Disputed = 5,
    Resolved = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub arbiter: Address,
    pub review_window: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Task {
    pub client: Address,
    pub token: Address,
    pub amount: i128,
    /// Ledger timestamp after which the payee can no longer submit.
    pub deadline: u64,
    /// Snapshot of the configured arbiter when the task was funded.
    pub arbiter: Address,
    /// Snapshot of the configured review window when the task was funded.
    pub review_window: u64,
    pub payee: Option<Address>,
    /// sha256 of the off-chain submission evidence.
    pub evidence: Option<BytesN<32>>,
    pub submitted_at: u64,
    pub rejections: u32,
    /// When the last rejection happened; the payee gets one review window
    /// from then to dispute before the client can refund.
    pub rejected_at: u64,
    pub state: TaskState,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Token(Address),
    Task(BytesN<32>),
}

// ---------------------------------------------------------------------------
// Events. The task id is always the first topic after the event name, so an
// indexer can filter one task's history.
// ---------------------------------------------------------------------------

#[contractevent]
pub struct Funded {
    #[topic]
    pub task_id: BytesN<32>,
    pub client: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
}

#[contractevent]
pub struct Assigned {
    #[topic]
    pub task_id: BytesN<32>,
    pub payee: Address,
}

#[contractevent]
pub struct Submitted {
    #[topic]
    pub task_id: BytesN<32>,
    pub evidence: BytesN<32>,
    pub submitted_at: u64,
}

#[contractevent]
pub struct Rejected {
    #[topic]
    pub task_id: BytesN<32>,
    pub rejections: u32,
}

#[contractevent]
pub struct Abandoned {
    #[topic]
    pub task_id: BytesN<32>,
    pub payee: Address,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub task_id: BytesN<32>,
    pub payee: Address,
    pub amount: i128,
    pub by_timeout: bool,
}

#[contractevent]
pub struct Refunded {
    #[topic]
    pub task_id: BytesN<32>,
    pub client: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Disputed {
    #[topic]
    pub task_id: BytesN<32>,
    pub by: Address,
}

#[contractevent]
pub struct Resolved {
    #[topic]
    pub task_id: BytesN<32>,
    pub payee_amount: i128,
    pub client_amount: i128,
    pub payee_bps: u32,
}

#[contract]
pub struct TaskEscrow;

#[contractimpl]
impl TaskEscrow {
    /// Runs once, atomically with deployment, so the configuration cannot be
    /// front-run by another caller.
    pub fn __constructor(
        env: Env,
        admin: Address,
        arbiter: Address,
        review_window: u64,
        tokens: soroban_sdk::Vec<Address>,
    ) -> Result<(), Error> {
        check_review_window(review_window)?;
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                arbiter,
                review_window,
            },
        );
        for token in tokens.iter() {
            env.storage().instance().set(&DataKey::Token(token), &true);
        }
        Ok(())
    }

    // ----- Admin (future tasks only) ---------------------------------------

    pub fn set_arbiter(env: Env, arbiter: Address) {
        let mut config = config(&env);
        config.admin.require_auth();
        config.arbiter = arbiter;
        env.storage().instance().set(&DataKey::Config, &config);
    }

    pub fn set_review_window(env: Env, review_window: u64) -> Result<(), Error> {
        let mut config = config(&env);
        config.admin.require_auth();
        check_review_window(review_window)?;
        config.review_window = review_window;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn set_token_allowed(env: Env, token: Address, allowed: bool) {
        config(&env).admin.require_auth();
        if allowed {
            env.storage().instance().set(&DataKey::Token(token), &true);
        } else {
            env.storage().instance().remove(&DataKey::Token(token));
        }
    }

    // ----- Task lifecycle ----------------------------------------------------

    /// Escrows `amount` of `token` from `client` for `task_id`.
    pub fn fund(
        env: Env,
        task_id: BytesN<32>,
        client: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<(), Error> {
        client.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !env.storage().instance().has(&DataKey::Token(token.clone())) {
            return Err(Error::TokenNotAllowed);
        }
        let now = env.ledger().timestamp();
        if deadline <= now || deadline - now > MAX_DEADLINE_SECS {
            return Err(Error::InvalidDeadline);
        }
        let key = DataKey::Task(task_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::TaskExists);
        }

        let config = config(&env);
        let task = Task {
            client: client.clone(),
            token: token.clone(),
            amount,
            deadline,
            arbiter: config.arbiter,
            review_window: config.review_window,
            payee: None,
            evidence: None,
            submitted_at: 0,
            rejections: 0,
            rejected_at: 0,
            state: TaskState::Funded,
        };
        save(&env, &task_id, &task);
        token::Client::new(&env, &token).transfer(&client, env.current_contract_address(), &amount);
        Funded {
            task_id,
            client,
            token,
            amount,
            deadline,
        }
        .publish(&env);
        Ok(())
    }

    /// Client names the account that will be paid for this task.
    pub fn assign(env: Env, task_id: BytesN<32>, payee: Address) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        task.client.require_auth();
        expect_state(&task, TaskState::Funded)?;
        if env.ledger().timestamp() >= task.deadline {
            return Err(Error::DeadlinePassed);
        }
        if payee == task.client {
            return Err(Error::InvalidPayee);
        }
        task.payee = Some(payee.clone());
        task.state = TaskState::Assigned;
        save(&env, &task_id, &task);
        Assigned { task_id, payee }.publish(&env);
        Ok(())
    }

    /// Payee records the hash of its submitted work and starts the review
    /// window. Allowed until the deadline, including after a rejection.
    pub fn submit(env: Env, task_id: BytesN<32>, evidence: BytesN<32>) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        let payee = payee(&task)?;
        payee.require_auth();
        expect_state(&task, TaskState::Assigned)?;
        let now = env.ledger().timestamp();
        if now > task.deadline {
            return Err(Error::DeadlinePassed);
        }
        task.evidence = Some(evidence.clone());
        task.submitted_at = now;
        task.state = TaskState::Submitted;
        save(&env, &task_id, &task);
        Submitted {
            task_id,
            evidence,
            submitted_at: now,
        }
        .publish(&env);
        Ok(())
    }

    /// Client rejects the current submission within the review window; the
    /// payee may resubmit before the deadline, abandon, or dispute.
    pub fn reject(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        task.client.require_auth();
        expect_state(&task, TaskState::Submitted)?;
        let now = env.ledger().timestamp();
        if now >= task.submitted_at + task.review_window {
            return Err(Error::ReviewWindowClosed);
        }
        task.evidence = None;
        task.submitted_at = 0;
        task.rejections += 1;
        task.rejected_at = now;
        task.state = TaskState::Assigned;
        save(&env, &task_id, &task);
        Rejected {
            task_id,
            rejections: task.rejections,
        }
        .publish(&env);
        Ok(())
    }

    /// Client approves the submission and pays the payee.
    pub fn approve(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let task = load(&env, &task_id)?;
        task.client.require_auth();
        expect_state(&task, TaskState::Submitted)?;
        release(&env, task_id, task, false)
    }

    /// Payee collects payment when the client has not approved, rejected or
    /// disputed within the review window.
    pub fn claim(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let task = load(&env, &task_id)?;
        payee(&task)?.require_auth();
        expect_state(&task, TaskState::Submitted)?;
        if env.ledger().timestamp() < task.submitted_at + task.review_window {
            return Err(Error::ReviewWindowOpen);
        }
        release(&env, task_id, task, true)
    }

    /// Payee withdraws from the task; it returns to Funded so the client can
    /// reassign or refund.
    pub fn abandon(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        let payee = payee(&task)?;
        payee.require_auth();
        if task.state != TaskState::Assigned && task.state != TaskState::Submitted {
            return Err(Error::InvalidState);
        }
        task.payee = None;
        task.evidence = None;
        task.submitted_at = 0;
        task.state = TaskState::Funded;
        save(&env, &task_id, &task);
        Abandoned { task_id, payee }.publish(&env);
        Ok(())
    }

    /// Client recovers the escrow: any time while unassigned, or once the
    /// deadline has passed without a pending submission and the payee has had
    /// a full review window to dispute the latest rejection.
    pub fn refund(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        task.client.require_auth();
        match task.state {
            TaskState::Funded => {}
            TaskState::Assigned => {
                let now = env.ledger().timestamp();
                if now <= task.deadline {
                    return Err(Error::DeadlineNotPassed);
                }
                if task.rejections > 0 && now < task.rejected_at + task.review_window {
                    return Err(Error::ReviewWindowOpen);
                }
            }
            _ => return Err(Error::InvalidState),
        }
        task.state = TaskState::Refunded;
        save(&env, &task_id, &task);
        token::Client::new(&env, &task.token).transfer(
            &env.current_contract_address(),
            &task.client,
            &task.amount,
        );
        Refunded {
            task_id,
            client: task.client,
            amount: task.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Client or payee freezes the escrow for the task's arbiter.
    pub fn dispute(env: Env, task_id: BytesN<32>, by: Address) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        by.require_auth();
        if by != task.client && Some(by.clone()) != task.payee {
            return Err(Error::NotParty);
        }
        if task.state != TaskState::Assigned && task.state != TaskState::Submitted {
            return Err(Error::InvalidState);
        }
        task.state = TaskState::Disputed;
        save(&env, &task_id, &task);
        Disputed { task_id, by }.publish(&env);
        Ok(())
    }

    /// The task's arbiter splits the escrow: `payee_bps` of it to the payee,
    /// the exact remainder to the client.
    pub fn resolve(env: Env, task_id: BytesN<32>, payee_bps: u32) -> Result<(), Error> {
        let mut task = load(&env, &task_id)?;
        task.arbiter.require_auth();
        expect_state(&task, TaskState::Disputed)?;
        if payee_bps > BPS_DENOMINATOR {
            return Err(Error::InvalidBps);
        }
        let payee = payee(&task)?;
        let payee_amount = task.amount * payee_bps as i128 / BPS_DENOMINATOR as i128;
        let client_amount = task.amount - payee_amount;

        task.state = TaskState::Resolved;
        save(&env, &task_id, &task);
        let token = token::Client::new(&env, &task.token);
        let this = env.current_contract_address();
        if payee_amount > 0 {
            token.transfer(&this, &payee, &payee_amount);
        }
        if client_amount > 0 {
            token.transfer(&this, &task.client, &client_amount);
        }
        Resolved {
            task_id,
            payee_amount,
            client_amount,
            payee_bps,
        }
        .publish(&env);
        Ok(())
    }

    // ----- Views ---------------------------------------------------------------

    pub fn get_task(env: Env, task_id: BytesN<32>) -> Result<Task, Error> {
        load(&env, &task_id)
    }

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage().instance().has(&DataKey::Token(token))
    }

    /// Anyone may extend a task's storage lifetime.
    pub fn bump(env: Env, task_id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Task(task_id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::TaskNotFound);
        }
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }
}

fn config(env: &Env) -> Config {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    // Set by the constructor, so it is always present.
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn check_review_window(review_window: u64) -> Result<(), Error> {
    if !(MIN_REVIEW_WINDOW_SECS..=MAX_REVIEW_WINDOW_SECS).contains(&review_window) {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

fn load(env: &Env, task_id: &BytesN<32>) -> Result<Task, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Task(task_id.clone()))
        .ok_or(Error::TaskNotFound)
}

fn save(env: &Env, task_id: &BytesN<32>, task: &Task) {
    let key = DataKey::Task(task_id.clone());
    env.storage().persistent().set(&key, task);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn expect_state(task: &Task, state: TaskState) -> Result<(), Error> {
    if task.state != state {
        return Err(Error::InvalidState);
    }
    Ok(())
}

fn payee(task: &Task) -> Result<Address, Error> {
    task.payee.clone().ok_or(Error::InvalidState)
}

/// Pays the full escrow to the payee. The task is marked Released before the
/// transfer, so a second approve or claim fails with InvalidState.
fn release(env: &Env, task_id: BytesN<32>, mut task: Task, by_timeout: bool) -> Result<(), Error> {
    let payee = payee(&task)?;
    task.state = TaskState::Released;
    save(env, &task_id, &task);
    token::Client::new(env, &task.token).transfer(
        &env.current_contract_address(),
        &payee,
        &task.amount,
    );
    Released {
        task_id,
        payee,
        amount: task.amount,
        by_timeout,
    }
    .publish(env);
    Ok(())
}

#[cfg(test)]
mod test;
