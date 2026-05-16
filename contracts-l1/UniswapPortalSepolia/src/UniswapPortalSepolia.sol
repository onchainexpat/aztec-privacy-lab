// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

// Sepolia-friendly fork of the bundled UniswapPortal. The bundled
// l1-artifacts portal hardcodes the mainnet Uniswap V3 SwapRouter address; on
// Sepolia, V3 lives at a different address so we accept the router as an
// initialize() parameter. Everything else mirrors the upstream pattern.
//
// Vendored interfaces live inline so this Foundry project builds without the
// upstream @aztec/core source tree or OpenZeppelin.

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
    function depositToAztecPrivate(
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption
    ) external returns (bytes32, uint256);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title UniswapPortalSepolia
/// @notice Variant of Aztec's UniswapPortal with a runtime-configurable router
///         address so it works against the Sepolia V3 deployment (or any other
///         non-mainnet chain).
contract UniswapPortalSepolia {
    ISwapRouter public router;
    IRegistry public registry;
    bytes32 public l2UniswapAddress;
    IRollup public rollup;
    IOutbox public outbox;
    uint256 public rollupVersion;

    struct LocalSwapVars {
        IERC20 inputAsset;
        IERC20 outputAsset;
        bytes32 contentHash;
    }

    /// @param _registry Aztec L1 registry contract on this chain.
    /// @param _l2UniswapAddress Aztec L2 contract that emits the swap messages.
    /// @param _router Uniswap V3 SwapRouter (or compatible) on this chain.
    function initialize(
        address _registry,
        bytes32 _l2UniswapAddress,
        address _router
    ) external {
        registry = IRegistry(_registry);
        l2UniswapAddress = _l2UniswapAddress;
        router = ISwapRouter(_router);

        rollup = IRollup(registry.getCanonicalRollup());
        outbox = IOutbox(rollup.getOutbox());
        rollupVersion = rollup.getVersion();
    }

    /// @notice Same semantics as bundled UniswapPortal.swapPrivate but uses the
    ///         configurable router instead of the mainnet constant.
    function swapPrivate(
        address _inputTokenPortal,
        uint256 _inAmount,
        uint24 _uniswapFeeTier,
        address _outputTokenPortal,
        uint256 _amountOutMinimum,
        bytes32 _secretHashForL1ToL2Message,
        bool _withCaller,
        DataStructures.OutboxMessageMetadata[2] calldata _outboxMessageMetadata
    ) external returns (bytes32, uint256) {
        LocalSwapVars memory vars;

        vars.inputAsset = ITokenPortal(_inputTokenPortal).underlying();
        vars.outputAsset = ITokenPortal(_outputTokenPortal).underlying();

        // 1. Withdraw from the input token portal.
        ITokenPortal(_inputTokenPortal).withdraw(
            address(this),
            _inAmount,
            true,
            _outboxMessageMetadata[0]._epoch,
            _outboxMessageMetadata[0]._leafIndex,
            _outboxMessageMetadata[0]._path
        );

        // 2. Consume the swap-intent message.
        vars.contentHash = _sha256ToField(
            abi.encodeWithSignature(
                "swap_private(address,uint256,uint24,address,uint256,bytes32,address)",
                _inputTokenPortal,
                _inAmount,
                _uniswapFeeTier,
                _outputTokenPortal,
                _amountOutMinimum,
                _secretHashForL1ToL2Message,
                _withCaller ? msg.sender : address(0)
            )
        );
        outbox.consume(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(l2UniswapAddress, rollupVersion),
                recipient: DataStructures.L1Actor(address(this), block.chainid),
                content: vars.contentHash
            }),
            _outboxMessageMetadata[1]._epoch,
            _outboxMessageMetadata[1]._leafIndex,
            _outboxMessageMetadata[1]._path
        );

        // 3. Approve + swap via the configured router.
        vars.inputAsset.approve(address(router), _inAmount);
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(vars.inputAsset),
            tokenOut: address(vars.outputAsset),
            fee: _uniswapFeeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _inAmount,
            amountOutMinimum: _amountOutMinimum,
            sqrtPriceLimitX96: 0
        });
        uint256 amountOut = router.exactInputSingle(swapParams);

        // 4. Forward the output amount back to L2 as a private claim.
        vars.outputAsset.approve(_outputTokenPortal, amountOut);
        return ITokenPortal(_outputTokenPortal).depositToAztecPrivate(
            amountOut,
            _secretHashForL1ToL2Message
        );
    }

    function _sha256ToField(bytes memory _data) internal pure returns (bytes32) {
        return bytes32(bytes.concat(new bytes(1), bytes31(sha256(_data))));
    }
}
