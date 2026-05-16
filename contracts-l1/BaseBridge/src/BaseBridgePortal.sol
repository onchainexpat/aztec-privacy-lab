// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

// Self-contained L1 portal for the "Aztec L2 -> Base L2" variant. Pattern
// mirrors Aztec's bundled UniswapPortal:
//   1. Consume an L2->L1 withdrawal message from the input TokenPortal (this
//      releases the underlying ERC20 to this contract).
//   2. Consume the "bridge_to_base" L2->L1 message emitted by the L2
//      BaseBridge contract.
//   3. Forward the released ERC20 to the Base L1StandardBridge.
//
// Vendored interfaces live inline so this Foundry project builds without the
// upstream @aztec/core source tree.

type Epoch is uint256;

library DataStructures {
    struct L1Actor {
        address actor;
        uint256 chainId;
    }
    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }
    struct L2ToL1Msg {
        L2Actor sender;
        L1Actor recipient;
        bytes32 content;
    }
    // Used to thread (epoch, leafIndex, path) through the swap call so the
    // portal can prove inclusion in the outbox merkle tree.
    struct OutboxMessageMetadata {
        Epoch _epoch;
        uint256 _leafIndex;
        bytes32[] _path;
    }
}

interface IOutbox {
    function consume(
        DataStructures.L2ToL1Msg calldata _message,
        Epoch _epoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external;
}

interface IRollup {
    function getOutbox() external view returns (address);
    function getVersion() external view returns (uint256);
}

interface IRegistry {
    function getCanonicalRollup() external view returns (address);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface ITokenPortal {
    function underlying() external view returns (IERC20);
    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        Epoch _epoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external;
}

interface IBaseL1StandardBridge {
    function bridgeERC20To(
        address _l1Token,
        address _l2Token,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external;
}

/// @title BaseBridgePortal
/// @notice L1 endpoint for the Aztec L2 -> Base L2 bridge variant.
contract BaseBridgePortal {
    IRegistry public registry;
    bytes32 public l2BridgeAddress;
    IRollup public rollup;
    IOutbox public outbox;
    uint256 public rollupVersion;
    IBaseL1StandardBridge public baseStandardBridge;

    function initialize(
        address _registry,
        bytes32 _l2BridgeAddress,
        address _baseStandardBridge
    ) external {
        registry = IRegistry(_registry);
        l2BridgeAddress = _l2BridgeAddress;
        rollup = IRollup(registry.getCanonicalRollup());
        outbox = IOutbox(rollup.getOutbox());
        rollupVersion = rollup.getVersion();
        baseStandardBridge = IBaseL1StandardBridge(_baseStandardBridge);
    }

    /**
     * @notice Consume the two L2->L1 messages (withdrawal + bridge intent),
     *         pull the released ERC20 in, and forward to Base.
     * @param _inputTokenPortal L1 portal that escrows the input ERC20.
     * @param _amount Amount of input ERC20 being bridged.
     * @param _baseRecipient Address on Base L2 that receives the tokens.
     * @param _baseMinGasLimit Gas budget for the Base side deposit.
     * @param _withCaller If true, the L2 bridge bound `msg.sender` as the only
     *        valid L1 caller. If false, anyone can complete the bridge.
     * @param _outboxMessageMetadata [0] = withdrawal message meta, [1] = bridge
     *        intent message meta. Both messages must be in the outbox.
     */
    function bridgeToBase(
        address _inputTokenPortal,
        uint256 _amount,
        address _baseRecipient,
        uint32 _baseMinGasLimit,
        bool _withCaller,
        DataStructures.OutboxMessageMetadata[2] calldata _outboxMessageMetadata
    ) external returns (bytes32) {
        IERC20 inputAsset = ITokenPortal(_inputTokenPortal).underlying();

        // 1. Withdraw the ERC20 from the input portal into this contract.
        ITokenPortal(_inputTokenPortal).withdraw(
            address(this),
            _amount,
            true,
            _outboxMessageMetadata[0]._epoch,
            _outboxMessageMetadata[0]._leafIndex,
            _outboxMessageMetadata[0]._path
        );

        // 2. Consume the bridge-intent message. Content hash matches what the
        //    L2 base_bridge contract computed via compute_bridge_to_base_content_hash.
        bytes32 contentHash = _sha256ToField(
            abi.encodeWithSignature(
                "bridge_to_base(address,uint256,address,uint32,address)",
                _inputTokenPortal,
                _amount,
                _baseRecipient,
                _baseMinGasLimit,
                _withCaller ? msg.sender : address(0)
            )
        );
        outbox.consume(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(l2BridgeAddress, rollupVersion),
                recipient: DataStructures.L1Actor(address(this), block.chainid),
                content: contentHash
            }),
            _outboxMessageMetadata[1]._epoch,
            _outboxMessageMetadata[1]._leafIndex,
            _outboxMessageMetadata[1]._path
        );

        // 3. Forward to the Base L1StandardBridge.
        inputAsset.approve(address(baseStandardBridge), _amount);
        baseStandardBridge.bridgeERC20To(
            address(inputAsset),
            address(0),
            _baseRecipient,
            _amount,
            _baseMinGasLimit,
            ""
        );

        return contentHash;
    }

    // Aztec encoding: take the sha256, replace the high byte with zero so the
    // result fits in a BN254 field element. Matches the Noir contract's
    // sha256_to_field used to compute the content hash.
    function _sha256ToField(bytes memory _data) internal pure returns (bytes32) {
        return bytes32(bytes.concat(new bytes(1), bytes31(sha256(_data))));
    }
}
