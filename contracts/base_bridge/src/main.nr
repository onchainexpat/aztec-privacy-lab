// BaseBridge - privacy matrix variant i.
//
// Aztec L2 (private notes) -> L1 portal -> Base L2 (public recipient).
//
// Pattern mirrors the bundled UniswapContract.swap_private:
//   1. transfer_to_public: caller's private notes burn into contract's public
//      balance. Caller's L2 identity stays in the private kernel.
//   2. enqueue _approve_bridge_and_exit_input_asset_to_L1: contract becomes a
//      minter for the L2 TokenBridge and authorizes burn_public which queues an
//      L2->L1 withdrawal message at the token's L1 portal.
//   3. message_portal: emit a second L2->L1 message keyed by a content hash of
//      the bridge args. The L1 BaseBridgePortal consumes both messages, pulls
//      the released ERC20, and forwards them to the Base L1StandardBridge.
//
// Privacy properties:
//   - L2 depositor: hidden (same as variant h).
//   - Base recipient: public (visible in the portal call + the Base L2 deposit).
//   - Depositor <-> recipient link: broken at the portal contract boundary -
//     anyone watching only sees "portal X sent N tokens to address Y on Base".
//   - Anonymity set: other Aztec depositors funneling through this same portal.
//
// One-way only: there is no return claim message because the assets leave the
// Aztec system entirely.

mod util;

use aztec::macros::aztec;

#[aztec]
pub contract BaseBridge {
    use aztec::{
        authwit::auth::{compute_authwit_message_hash_from_call, set_authorized},
        macros::{functions::{external, initializer, only_self}, storage::storage},
        protocol::{
            abis::function_selector::FunctionSelector,
            address::{AztecAddress, EthAddress},
            traits::ToField,
        },
        state_vars::PublicImmutable,
    };

    use crate::util::compute_bridge_to_base_content_hash;
    use token::Token;
    use token_bridge::TokenBridge;

    #[storage]
    struct Storage<Context> {
        portal_address: PublicImmutable<EthAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(portal_address: EthAddress) {
        self.storage.portal_address.initialize(portal_address);
    }

    // Bridge `input_amount` of `input_asset` from the caller's private balance
    // out to L1 and on to `base_recipient` on Base L2. `base_min_gas_limit` is
    // the gas budget the L1StandardBridge forwards with the deposit (200000 is
    // a reasonable default for ERC20 deposits).
    #[external("private")]
    fn bridge_private(
        input_asset: AztecAddress,
        input_asset_bridge: AztecAddress,
        input_amount: u128,
        base_recipient: EthAddress,
        base_min_gas_limit: Field,
        nonce_for_transfer_to_public_approval: Field,
        caller_on_L1: EthAddress,
    ) {
        let input_asset_bridge_config =
            self.view(TokenBridge::at(input_asset_bridge).get_config());

        assert(
            input_asset.eq(input_asset_bridge_config.token),
            "input_asset address is not the same as seen in the bridge contract",
        );
        assert(
            !input_asset_bridge_config.portal.is_zero(),
            "L1 portal address of input_asset's bridge is 0",
        );

        // Burn the caller's private notes into the contract's public balance.
        self.call(Token::at(input_asset).transfer_to_public(
            self.msg_sender(),
            self.address,
            input_amount,
            nonce_for_transfer_to_public_approval,
        ));

        // Authorize the bridge to burn this contract's public balance and
        // queue an L2->L1 withdrawal at the input asset's L1 portal.
        self.enqueue_self._approve_bridge_and_exit_input_asset_to_L1(
            input_asset,
            input_asset_bridge,
            input_amount,
        );

        // Emit the "bridge to base" L2->L1 message. The L1 portal will consume
        // both this and the withdrawal message above, then forward the released
        // tokens to the Base L1StandardBridge.
        let content_hash = compute_bridge_to_base_content_hash(
            input_asset_bridge_config.portal,
            input_amount,
            base_recipient,
            base_min_gas_limit,
            caller_on_L1,
        );
        self.context.message_portal(self.storage.portal_address.read(), content_hash);
    }

    // Helper that authorizes the L2 TokenBridge to burn this contract's
    // public balance and exits the input asset to the L1 BaseBridgePortal.
    #[external("public")]
    #[only_self]
    fn _approve_bridge_and_exit_input_asset_to_L1(
        token: AztecAddress,
        token_bridge: AztecAddress,
        amount: u128,
    ) {
        let authwit_nonce = 0xdeadbeef;
        let selector = FunctionSelector::from_signature("burn_public((Field),u128,Field)");
        let message_hash = compute_authwit_message_hash_from_call(
            token_bridge,
            token,
            self.context.chain_id(),
            self.context.version(),
            selector,
            [self.address.to_field(), amount as Field, authwit_nonce],
        );
        set_authorized(self.context, message_hash, true);

        let this_portal_address = self.storage.portal_address.read();
        // Recipient on L1 of the released funds is the BaseBridgePortal itself,
        // which then forwards to Base.
        self.call(TokenBridge::at(token_bridge).exit_to_l1_public(
            this_portal_address,
            amount,
            this_portal_address,
            authwit_nonce,
        ));
    }
}
