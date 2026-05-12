// PublicTotalCrowdfunding - launchpad variant lp2.
//
// Public running total (anyone can verify the raise), private donor identities.
// The donor calls donate() privately; their token note is transferred out via
// transfer_to_public (so the contract's public AZA balance accumulates), and
// the contract enqueues a public increment of the total_raised counter.
// Observers see the counter and the contract's public balance grow but cannot
// link increments to specific donor addresses.

use aztec::macros::aztec;

#[aztec]
pub contract PublicTotalCrowdfunding {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::state_vars::{PublicImmutable, PublicMutable, StateVariable};
    use token::Token;

    #[storage]
    struct Storage<Context> {
        donation_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        total_raised: PublicMutable<u128, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(donation_token: AztecAddress, operator: AztecAddress) {
        self.storage.donation_token.initialize(donation_token);
        self.storage.operator.initialize(operator);
    }

    // Caller (the donor) keeps their identity private. The amount is moved
    // from the donor's private balance to the contract's public balance, and
    // the total_raised counter is bumped in a follow-up public call.
    #[external("private")]
    fn donate(amount: u128, authwit_nonce: Field) {
        let donor = self.msg_sender();
        let token = self.storage.donation_token.read();
        Token::at(token)
            .transfer_to_public(donor, self.address, amount, authwit_nonce)
            .call(self.context);
        self.enqueue_self._increment_total(amount);
    }

    #[external("public")]
    #[only_self]
    fn _increment_total(amount: u128) {
        let current = self.storage.total_raised.read();
        self.storage.total_raised.write(current + amount);
    }

    #[external("utility")]
    unconstrained fn get_total_raised() -> pub u128 {
        self.storage.total_raised.read()
    }
}
