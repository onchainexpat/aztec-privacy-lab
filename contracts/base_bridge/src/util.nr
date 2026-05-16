use aztec::protocol::{address::EthAddress, hash::sha256_to_field, traits::ToField};

// Content hash for the "bridge to base" L2->L1 message. The L1 BaseBridgePortal
// recomputes the same hash from the calldata it receives and consumes this
// message from the outbox. Five fields of 32 bytes + 4 byte selector = 164.
pub fn compute_bridge_to_base_content_hash(
    input_asset_bridge_portal_address: EthAddress,
    input_amount: u128,
    base_recipient: EthAddress,
    base_min_gas_limit: Field,
    caller_on_L1: EthAddress,
) -> Field {
    let mut hash_bytes = [0; 164];
    let input_token_portal_bytes: [u8; 32] =
        input_asset_bridge_portal_address.to_field().to_be_bytes();
    let in_amount_bytes: [u8; 32] = input_amount.to_field().to_be_bytes();
    let base_recipient_bytes: [u8; 32] = base_recipient.to_field().to_be_bytes();
    let base_min_gas_limit_bytes: [u8; 32] = base_min_gas_limit.to_be_bytes();
    let caller_on_L1_bytes: [u8; 32] = caller_on_L1.to_field().to_be_bytes();

    let selector: [u8; 32] = comptime {
        keccak256::keccak256(
            "bridge_to_base(address,uint256,address,uint32,address)".as_bytes(),
            54,
        )
    };

    hash_bytes[0] = selector[0];
    hash_bytes[1] = selector[1];
    hash_bytes[2] = selector[2];
    hash_bytes[3] = selector[3];

    for i in 0..32 {
        hash_bytes[i + 4] = input_token_portal_bytes[i];
        hash_bytes[i + 36] = in_amount_bytes[i];
        hash_bytes[i + 68] = base_recipient_bytes[i];
        hash_bytes[i + 100] = base_min_gas_limit_bytes[i];
        hash_bytes[i + 132] = caller_on_L1_bytes[i];
    }

    sha256_to_field(hash_bytes)
}
