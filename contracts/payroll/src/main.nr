// Payroll - confidential payroll register with private claims.
//
// USE CASE: an employer runs payroll without publishing who earns what. The
// employer funds a pool and publishes one opaque commitment per employee per
// pay period. Each employee later claims privately: the claim hides WHICH
// registered employee is claiming, and pays out to a recipient address that
// need not be linkable to the employee's registered identity.
//
// FLOW:
//   1. Operator funds the contract's public USDC balance (fund). Only the
//      aggregate funded total is public.
//   2. For pay period P, the operator publishes a payslip per employee:
//      commitment C = pedersen([employee_addr, amount, P]) via add_payslip.
//      Observers see N opaque commitments - not the recipients or amounts.
//   3. The employee calls claim(amount, P, recipient) privately. The contract
//      recomputes C from the (hidden) caller + the claimed amount + period,
//      verifies C is a claimable payslip, marks it claimed, and releases the
//      USDC to `recipient`. The employee's registered identity stays in the
//      private kernel.
//   4. advance_period bumps the active period so the operator can re-issue the
//      same (employee, amount) pair next cycle as a fresh, distinct commitment.
//
// PRIVACY MODEL (honest boundary):
//   - HIDDEN: the full salary register stays opaque until claimed (commitments
//     reveal nothing); the operator <-> employee <-> amount mapping; and WHICH
//     registered employee is claiming (the claim is a private function, so the
//     caller never leaves the private kernel).
//   - PUBLIC AT CLAIM: the payout `amount` and the `recipient` address. The
//     contract custodies funds in PUBLIC balance (the established Aztec pattern
//     for contract-held funds - see GoodsEscrow/AMM), so the release is a
//     public transfer. Paying to a fresh/burner `recipient` keeps the payout
//     unlinkable to the employee's registered identity, but the amount is
//     visible at the moment of claim. A fully-amount-private payout would need
//     contract-owned private notes, which is not an established pattern here.
//
// COMPARISON TO SOLIDITY: a Solidity payroll either publishes every (address,
// amount) pair on-chain or trusts an off-chain paymaster. Aztec hides the
// register and the claimant set for free via commitments + the private kernel.

use aztec::macros::aztec;

#[aztec]
pub contract Payroll {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global SLOT_CLAIMABLE: u8 = 1;
    global SLOT_CLAIMED: u8 = 2;
    // Per-claim payout cap (guards the demo pool against a single huge claim via
    // the permissionless demo_add_payslip path). Above the demo payslip amounts.
    global DEMO_MAX_PAYSLIP: u128 = 10000;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        // Active pay period. Bumped by the operator each cycle.
        period: PublicMutable<u64, Context>,
        // Aggregate USDC funded into the pool (public).
        total_funded: PublicMutable<u128, Context>,
        payslip_count: PublicMutable<u32, Context>,
        claimed_count: PublicMutable<u32, Context>,
        // commitment -> 0=unset, 1=claimable, 2=claimed
        payslips: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress, operator: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.operator.initialize(operator);
    }

    // Operator tops up the contract's public USDC balance. Private function so
    // the operator's identity stays in the kernel; only the aggregate funded
    // total lands in public state.
    #[external("private")]
    fn fund(amount: u128, authwit_nonce: Field) {
        let op = self.msg_sender();
        assert(op == self.storage.operator.read(), "only operator");
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_to_public(op, self.address, amount, authwit_nonce).call(
            self.context,
        );
        self.enqueue_self._record_funding(amount);
    }

    #[external("public")]
    #[only_self]
    fn _record_funding(amount: u128) {
        let prev = self.storage.total_funded.read();
        self.storage.total_funded.write(prev + amount);
    }

    // Operator publishes a payslip commitment for the current period.
    // commitment = pedersen([employee_addr, amount, period]).
    #[external("public")]
    fn add_payslip(commitment: Field) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        assert(self.storage.payslips.at(commitment).read() == 0, "payslip already added");
        self.storage.payslips.at(commitment).write(SLOT_CLAIMABLE);
        let prev = self.storage.payslip_count.read();
        self.storage.payslip_count.write(prev + 1);
    }

    // DEMO-ONLY: permissionless payslip publish so a shared-testnet visitor can
    // play both employer + employee in their own session (publish an opaque
    // payslip commitment for themselves, then claim it privately). The
    // production path is the operator-gated add_payslip above; this exists so
    // the public demo is interactive. The pool is operator-funded; claims are
    // capped via DEMO_MAX_PAYSLIP in _consume_and_pay.
    #[external("public")]
    fn demo_add_payslip(commitment: Field) {
        assert(self.storage.payslips.at(commitment).read() == 0, "payslip already added");
        self.storage.payslips.at(commitment).write(SLOT_CLAIMABLE);
        let prev = self.storage.payslip_count.read();
        self.storage.payslip_count.write(prev + 1);
    }

    // Operator advances to the next pay period.
    #[external("public")]
    fn advance_period() {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        let prev = self.storage.period.read();
        self.storage.period.write(prev + 1);
    }

    // Employee claims their payslip privately. The caller proves knowledge that
    // pedersen([caller, amount, period]) is a claimable payslip; the payout
    // goes to `recipient` (which may be unlinkable to the caller). The caller's
    // registered identity never leaves the private kernel.
    #[external("private")]
    fn claim(amount: u128, period: u64, recipient: AztecAddress) {
        let employee = self.msg_sender();
        let commitment =
            std::hash::pedersen_hash([employee.to_field(), amount as Field, period as Field]);
        self.enqueue_self._consume_and_pay(commitment, recipient, amount);
    }

    #[external("public")]
    #[only_self]
    fn _consume_and_pay(commitment: Field, recipient: AztecAddress, amount: u128) {
        assert(
            self.storage.payslips.at(commitment).read() == SLOT_CLAIMABLE,
            "no claimable payslip or already claimed",
        );
        assert(amount <= DEMO_MAX_PAYSLIP, "exceeds demo payout cap");
        self.storage.payslips.at(commitment).write(SLOT_CLAIMED);
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_public(self.address, recipient, amount, 0).call(self.context);
        let prev = self.storage.claimed_count.read();
        self.storage.claimed_count.write(prev + 1);
    }

    #[external("utility")]
    unconstrained fn get_slot_status(commitment: Field) -> pub u8 {
        self.storage.payslips.at(commitment).read()
    }

    #[external("utility")]
    unconstrained fn get_period() -> pub u64 {
        self.storage.period.read()
    }

    #[external("utility")]
    unconstrained fn get_total_funded() -> pub u128 {
        self.storage.total_funded.read()
    }

    #[external("utility")]
    unconstrained fn get_payslip_count() -> pub u32 {
        self.storage.payslip_count.read()
    }

    #[external("utility")]
    unconstrained fn get_claimed_count() -> pub u32 {
        self.storage.claimed_count.read()
    }
}
