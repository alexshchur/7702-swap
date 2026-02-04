import "dotenv/config";

import { createPublicClient, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { to7702SimpleSmartAccount } from "permissionless/accounts";

const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDCe = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";
// Uniswap V3 periphery SwapRouter (classic ERC20 approve -> transferFrom)
const SWAP_ROUTER_V3 = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Simple7702Account v0.8 (delegate implementation)
const SIMPLE_7702_IMPL = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";

// 0.00001 WETH
const amountIn = 10_000_000_000_000n;

// Uniswap V3 pool fee tier for WETH/USDCe on Arbitrum
const poolFee = 500;

// 1 day from now
const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);

// ERC-20 approve(address spender, uint256 amount)
const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Uniswap V3 SwapRouter02 exactInputSingle((...)) ABI
const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const pimlicoKey = process.env.PIMLICO_API_KEY;
  if (!pk || !pimlicoKey)
    throw new Error("Missing PRIVATE_KEY or PIMLICO_API_KEY in .env");

  const usePaymaster = process.env.USE_PAYMASTER !== "0";

  const owner = privateKeyToAccount(pk);

  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });

  // Pimlico client (bundler + paymaster endpoints share the same RPC URL)
  const pimlicoUrl = `https://api.pimlico.io/v2/${arbitrum.id}/rpc?apikey=${pimlicoKey}`;
  const pimlicoClient = createPimlicoClient({
    chain: arbitrum,
    transport: http(pimlicoUrl),
  });

  // Build a 7702-backed smart account that uses your EOA address as the sender
  const account = await to7702SimpleSmartAccount({
    client: publicClient,
    owner,
  });

  const smartAccountClient = createSmartAccountClient({
    client: publicClient,
    chain: arbitrum,
    account,
    ...(usePaymaster ? { paymaster: pimlicoClient } : {}),
    bundlerTransport: http(pimlicoUrl),
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  const wethBalance = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner.address],
  });
  if (wethBalance < amountIn) {
    throw new Error(
      `Insufficient WETH balance for swap. Have ${wethBalance} wei, need ${amountIn} wei.`,
    );
  }

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    // Classic: approve the router to pull WETH via transferFrom.
    args: [SWAP_ROUTER_V3, 2n ** 256n - 1n],
  });

  const swapData = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDCe,
        fee: poolFee,
        recipient: owner.address,
        deadline,
        amountIn,
        amountOutMinimum: 0n, // unsafe, replace with real minOut
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const isDelegated = await smartAccountClient.account.isDeployed();

  let txHash;
  const calls = [
    { to: WETH, value: 0n, data: approveData },
    { to: SWAP_ROUTER_V3, value: 0n, data: swapData },
  ];

  if (!isDelegated) {
    // First time: include 7702 authorization to set EOA code to the implementation
    const nonce = await publicClient.getTransactionCount({
      address: owner.address,
    });

    txHash = await smartAccountClient.sendTransaction({
      calls,
      authorization: await owner.signAuthorization({
        address: SIMPLE_7702_IMPL,
        chainId: arbitrum.id,
        nonce,
      }),
    });
  } else {
    // Already delegated: no need to include authorization
    txHash = await smartAccountClient.sendTransaction({
      calls,
    });
  }

  console.log(`sent (gasless bundle tx): ${txHash}`);
}

main().catch((e) => {
  const message = `${e?.details ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  if (message.includes("Insufficient Pimlico balance for sponsorship")) {
    console.error(
      "\nPimlico paymaster sponsorship failed: your Pimlico balance is empty. " +
        "Top up your Pimlico account, or run with `USE_PAYMASTER=0` and fund the sender address with ETH to pay gas.",
    );
  }
  console.error(e);
  process.exit(1);
});
