// PublicCollateralPrivateDebt - lending variant ld2.
//
// Deposit collateral publicly, attribute it to a commitment, then borrow
// privately against the same commitment. The depositor's address + collateral
// amount are visible; the borrower's address and per-borrow draws are private.
//
// Position keying: commitment = pedersen(secret, owner_addr). The same person
// can act as both depositor and borrower. Observers see:
//   - public deposit event: depositor address + amount + commitment
//   - public LTV update: commitment + new debt total
// What's hidden: borrower address, the secret, that the depositor and borrower
// are the same wallet (unless the same commitment is reused observably).

use aztec::macros::aztec;

#[aztec]
pub contract PublicCollateralPrivateDebt {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    // 50 percent LTV: outstanding debt must stay below half of collateral.
    global LTV_NUMERATOR: u128 = 50;
    global LTV_DENOMINATOR: u128 = 100;

    #[storage]
    struct Storage<Context> {
        collateral_token: PublicImmutable<AztecAddress, Context>,
        debt_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        collateral: Map<Field, PublicMutable<u128, Context>, Context>,
        debt: Map<Field, PublicMutable<u128, Context>, Context>,
        total_collateral: PublicMutable<u128, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(
        collateral_token: AztecAddress,
        debt_token: AztecAddress,
        operator: AztecAddress,
    ) {
        self.storage.collateral_token.initialize(collateral_token);
        self.storage.debt_token.initialize(debt_token);
        self.storage.operator.initialize(operator);
    }

    // Public deposit. Caller publicly moves `amount` of the collateral token
    // into the contract and attributes it to `commitment`. Requires a
    // PublicAuthwit so the contract can pull the collateral from msg_sender.
    #[external("public")]
    fn deposit_public(amount: u128, commitment: Field, authwit_nonce: Field) {
        let from = self.msg_sender();
        let token = self.storage.collateral_token.read();
        Token::at(token)
            .transfer_in_public(from, self.address, amount, authwit_nonce)
            .call(self.context);
        let prev = self.storage.collateral.at(commitment).read();
        self.storage.collateral.at(commitment).write(prev + amount);
        let prev_total = self.storage.total_collateral.read();
        self.storage.total_collateral.write(prev_total + amount);
    }

    // Private borrow. Caller proves knowledge of (secret, owner) by
    // reconstructing commitment off-chain. Privately mints debt token to the
    // caller; enqueues a public LTV check + debt accounting.
    #[external("private")]
    fn borrow_private(secret: Field, owner: AztecAddress, amount: u128) {
        let commitment = std::hash::pedersen_hash([secret, owner.to_field()]);
        let debt_token = self.storage.debt_token.read();
        Token::at(debt_token).mint_to_private(self.msg_sender(), amount).call(self.context);
        self.enqueue_self._record_borrow(commitment, amount);
    }

    #[external("public")]
    #[only_self]
    fn _record_borrow(commitment: Field, amount: u128) {
        let coll = self.storage.collateral.at(commitment).read();
        let cur_debt = self.storage.debt.at(commitment).read();
        let new_debt = cur_debt + amount;
        assert(new_debt * LTV_DENOMINATOR <= coll * LTV_NUMERATOR, "ltv exceeded");
        self.storage.debt.at(commitment).write(new_debt);
    }

    #[external("utility")]
    unconstrained fn get_collateral(commitment: Field) -> pub u128 {
        self.storage.collateral.at(commitment).read()
    }

    #[external("utility")]
    unconstrained fn get_debt(commitment: Field) -> pub u128 {
        self.storage.debt.at(commitment).read()
    }

    #[external("utility")]
    unconstrained fn get_total_collateral() -> pub u128 {
        self.storage.total_collateral.read()
    }
}
