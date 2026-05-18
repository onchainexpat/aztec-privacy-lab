// SealedBidAuction - games variant g5.
//
// Anonymous sealed-bid first-price auction. Each bidder commits to a
// (bidder, amount, salt) tuple privately. Bids are opaque on-chain until the
// reveal window opens. Only the winning bidder has incentive to reveal - so
// losing bids stay encrypted in their PXEs forever.
//
// PRIVACY MODEL:
//   - place_bid is a private function. The L2 caller stays hidden in the
//     private kernel. The only public side-effect is incrementing a counter
//     and writing the bid commitment hash to a public map.
//   - The commitment hash = pedersen(bidder, amount, salt). It is one-way and
//     hiding (bidder picks a random salt). Observers see N opaque commitments
//     placed before the deadline.
//   - During the reveal window, any bidder may reveal_bid(amount, salt) - this
//     publishes the bid amount + bidder identity on-chain. Only the highest
//     reveal so far is kept as the current winner.
//   - After reveal_deadline, settle() finalizes. The winner is whoever revealed
//     the highest amount.  Bidders who didn't reveal stay anonymous forever.
//
// This is the cleanest pure-Aztec privacy showcase: every bid is committed to
// chain (sybil-resistant), losing bids are unconditionally hidden, and no
// trusted operator is required to keep bid amounts secret.
//
// DEMO NOTE: there is no escrow in this version. A production auction would
// require bidders to lock funds matching their max bid. Adding escrow leaks
// the upper bound of the bid, so the demo skips it to keep the privacy story
// clean. With escrow, you'd want a fixed "bid budget" deposit > the
// anonymity-set bid range.

use aztec::macros::aztec;

#[aztec]
pub contract SealedBidAuction {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};

    // Bid lifecycle marker stored at the commitment hash:
    //   0 = never placed
    //   1 = placed (sealed)
    //   2 = revealed
    global STATUS_PLACED: u8 = 1;
    global STATUS_REVEALED: u8 = 2;

    #[storage]
    struct Storage<Context> {
        operator: PublicImmutable<AztecAddress, Context>,
        // Off-chain item description (e.g., keccak of a description string).
        item_hash: PublicImmutable<Field, Context>,
        bid_deadline: PublicImmutable<u64, Context>,
        reveal_deadline: PublicImmutable<u64, Context>,
        // commitment hash -> bid lifecycle status
        commitments: Map<Field, PublicMutable<u8, Context>, Context>,
        // Aggregate counters / outcome
        bid_count: PublicMutable<u32, Context>,
        revealed_count: PublicMutable<u32, Context>,
        winning_bid: PublicMutable<u128, Context>,
        winner: PublicMutable<AztecAddress, Context>,
        settled: PublicMutable<bool, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(
        operator: AztecAddress,
        item_hash: Field,
        bid_deadline: u64,
        reveal_deadline: u64,
    ) {
        assert(bid_deadline < reveal_deadline, "reveal must follow bid window");
        self.storage.operator.initialize(operator);
        self.storage.item_hash.initialize(item_hash);
        self.storage.bid_deadline.initialize(bid_deadline);
        self.storage.reveal_deadline.initialize(reveal_deadline);
    }

    // Place a sealed bid. The caller stays hidden in the private kernel.
    // The bid amount + salt are bound to the caller's address via the
    // commitment hash; only the same caller can later reveal.
    #[external("private")]
    fn place_bid(amount: u128, salt: Field) {
        let bidder = self.msg_sender();
        let commitment = std::hash::pedersen_hash([
            bidder.to_field(),
            amount as Field,
            salt,
        ]);
        self.enqueue_self._record_commitment(commitment);
    }

    #[external("public")]
    #[only_self]
    fn _record_commitment(commitment: Field) {
        let now = self.context.timestamp();
        assert(now < self.storage.bid_deadline.read(), "bid window closed");
        assert(
            self.storage.commitments.at(commitment).read() == 0,
            "duplicate commitment",
        );
        self.storage.commitments.at(commitment).write(STATUS_PLACED);
        let prev = self.storage.bid_count.read();
        self.storage.bid_count.write(prev + 1);
    }

    // Reveal a previously-sealed bid. The bidder publishes amount + salt;
    // the contract recomputes the commitment, marks it revealed, and
    // updates the running winner.
    #[external("private")]
    fn reveal_bid(amount: u128, salt: Field) {
        let bidder = self.msg_sender();
        let commitment = std::hash::pedersen_hash([
            bidder.to_field(),
            amount as Field,
            salt,
        ]);
        self.enqueue_self._record_reveal(commitment, bidder, amount);
    }

    #[external("public")]
    #[only_self]
    fn _record_reveal(commitment: Field, bidder: AztecAddress, amount: u128) {
        let now = self.context.timestamp();
        assert(now >= self.storage.bid_deadline.read(), "reveal window not open");
        assert(now < self.storage.reveal_deadline.read(), "reveal window closed");
        assert(
            self.storage.commitments.at(commitment).read() == STATUS_PLACED,
            "no matching sealed bid",
        );
        self.storage.commitments.at(commitment).write(STATUS_REVEALED);
        let prev_revealed = self.storage.revealed_count.read();
        self.storage.revealed_count.write(prev_revealed + 1);

        let current_high = self.storage.winning_bid.read();
        if amount > current_high {
            self.storage.winning_bid.write(amount);
            self.storage.winner.write(bidder);
        }
    }

    // Finalize the auction. After reveal_deadline anyone can call settle to
    // lock in the outcome. The contract doesn't pay out automatically; this
    // is a privacy-primitive demo, not an escrowed market.
    #[external("public")]
    fn settle() {
        let now = self.context.timestamp();
        assert(now >= self.storage.reveal_deadline.read(), "reveal window still open");
        assert(!self.storage.settled.read(), "already settled");
        self.storage.settled.write(true);
    }

    #[external("utility")]
    unconstrained fn get_bid_count() -> pub u32 {
        self.storage.bid_count.read()
    }

    #[external("utility")]
    unconstrained fn get_revealed_count() -> pub u32 {
        self.storage.revealed_count.read()
    }

    #[external("utility")]
    unconstrained fn get_winning_bid() -> pub u128 {
        self.storage.winning_bid.read()
    }

    #[external("utility")]
    unconstrained fn get_winner() -> pub AztecAddress {
        self.storage.winner.read()
    }

    #[external("utility")]
    unconstrained fn get_settled() -> pub bool {
        self.storage.settled.read()
    }

    #[external("utility")]
    unconstrained fn get_commitment_status(commitment: Field) -> pub u8 {
        self.storage.commitments.at(commitment).read()
    }
}
