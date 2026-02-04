import "dotenv/config";

import {
  createPublicClient,
  encodeFunctionData,
  http,
  decodeErrorResult,
  decodeEventLog,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { entryPoint08Abi, entryPoint08Address } from "viem/account-abstraction";

import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { to7702SimpleSmartAccount } from "permissionless/accounts";

const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDCe = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";
const SWAP_ROUTER02 = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

// Simple7702Account v0.8 (delegate implementation)
const SIMPLE_7702_IMPL = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";

// 0.00001 WETH
const amountIn = 10_000_000_000_000n;

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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const wethAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
];

const uniswapV3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
];

const executeErrorAbi = [
  {
    type: "error",
    name: "ExecuteError",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "error", type: "bytes" },
    ],
  },
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }],
  },
];

function extractRevertData(err) {
  const candidates = [
    err?.data,
    err?.cause?.data,
    err?.cause?.cause?.data,
    err?.details,
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }

  const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  const match = text.match(/(0x[0-9a-fA-F]{8,})/);
  return match?.[1];
}

function tryDecodeExecuteError(revertData) {
  if (
    !revertData ||
    typeof revertData !== "string" ||
    !revertData.startsWith("0x")
  )
    return;
  try {
    const decoded = decodeErrorResult({
      abi: executeErrorAbi,
      data: revertData,
    });
    if (decoded.errorName !== "ExecuteError") return;

    const [index, inner] = decoded.args;
    console.error(`\nDecoded ExecuteError: index=${index}`);
    console.error(`Inner revert data: ${inner}`);

    if (inner && inner !== "0x") {
      try {
        const innerDecoded = decodeErrorResult({
          abi: executeErrorAbi,
          data: inner,
        });
        console.error(
          `Inner decoded error: ${innerDecoded.errorName}`,
          innerDecoded.args,
        );
      } catch {
        console.error(`Inner selector: ${inner.slice(0, 10)}`);
      }
    } else {
      console.error(
        `Inner revert data is empty (target reverted without reason).`,
      );
    }
  } catch {
    // ignore
  }
}

async function diagnoseBundleTx({ publicClient, bundleTxHash }) {
  const receipt = await publicClient.getTransactionReceipt({
    hash: bundleTxHash,
  });

  console.log(`\nBundle tx ${bundleTxHash}`);
  console.log(`status=${receipt.status} block=${receipt.blockNumber}`);

  const epLogs = receipt.logs.filter(
    (l) => l.address.toLowerCase() === entryPoint08Address.toLowerCase(),
  );
  console.log(`EntryPoint(${entryPoint08Address}) logs: ${epLogs.length}`);

  let sawUserOpEvent = false;
  /** @type {undefined | { sender: string, success: boolean, nonce: string, userOpHash: string }} */
  let lastUserOp;
  for (const log of epLogs) {
    try {
      const decoded = decodeEventLog({
        abi: entryPoint08Abi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "UserOperationEvent") {
        sawUserOpEvent = true;
        lastUserOp = {
          sender: decoded.args.sender,
          success: decoded.args.success,
          nonce: decoded.args.nonce?.toString?.() ?? decoded.args.nonce,
          userOpHash: decoded.args.userOpHash,
        };
        console.log("UserOperationEvent", {
          sender: decoded.args.sender,
          success: decoded.args.success,
          nonce: decoded.args.nonce?.toString?.() ?? decoded.args.nonce,
          actualGasCost:
            decoded.args.actualGasCost?.toString?.() ??
            decoded.args.actualGasCost,
          actualGasUsed:
            decoded.args.actualGasUsed?.toString?.() ??
            decoded.args.actualGasUsed,
          userOpHash: decoded.args.userOpHash,
        });
      }

      if (decoded.eventName === "UserOperationRevertReason") {
        console.log("UserOperationRevertReason", {
          sender: decoded.args.sender,
          nonce: decoded.args.nonce?.toString?.() ?? decoded.args.nonce,
          userOpHash: decoded.args.userOpHash,
        });
        const revertReason = decoded.args.revertReason;
        console.log("revertReason:", revertReason);
        tryDecodeExecuteError(revertReason);
      }
    } catch {
      // ignore
    }
  }

  if (!sawUserOpEvent) {
    console.log(
      "No UserOperationEvent found in this bundle tx. It may not be an EntryPoint v0.8 bundle, or RPC did not return logs.",
    );
  }

  return lastUserOp;
}

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

  const diagTx = process.env.DIAG_TX_HASH;
  if (diagTx) {
    await diagnoseBundleTx({ publicClient, bundleTxHash: diagTx });
    return;
  }

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

  console.log(`Paymaster sponsorship: ${usePaymaster ? "ON" : "OFF"}`);

  const wethBalance = await publicClient.readContract({
    address: WETH,
    abi: wethAbi,
    functionName: "balanceOf",
    args: [owner.address],
  });

  const usdcBefore = await publicClient.readContract({
    address: USDCe,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner.address],
  });

  const ethBalance = await publicClient.getBalance({ address: owner.address });
  const shouldWrapEthToWeth = wethBalance < amountIn && ethBalance >= amountIn;
  if (wethBalance < amountIn && !shouldWrapEthToWeth) {
    throw new Error(
      `Insufficient WETH balance. Have ${wethBalance} wei WETH and ${ethBalance} wei ETH; need ${amountIn} wei WETH. ` +
        `Either fund ${owner.address} with WETH on Arbitrum or increase ETH so it can be wrapped.`,
    );
  }

  const feeCandidates = [500, 3000, 10000];
  let fee = null;
  let pool = null;
  for (const candidate of feeCandidates) {
    const p = await publicClient.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: uniswapV3FactoryAbi,
      functionName: "getPool",
      args: [WETH, USDCe, candidate],
    });
    if (p && p !== zeroAddress) {
      fee = candidate;
      pool = p;
      break;
    }
  }
  if (!fee) {
    throw new Error(
      `No Uniswap V3 pool found for WETH/USDCe on fee tiers ${feeCandidates.join(
        ",",
      )}.`,
    );
  }
  console.log(`Using Uniswap V3 pool ${pool} with fee=${fee}`);

  const approveData = encodeFunctionData({
    abi: wethAbi,
    functionName: "approve",
    args: [SWAP_ROUTER02, amountIn],
  });

  const swapData = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDCe,
        fee,
        recipient: owner.address,
        deadline,
        amountIn,
        amountOutMinimum: 0n, // unsafe, replace with real minOut
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const isDelegated = await smartAccountClient.account.isDeployed();

  // Workaround: some bundlers (and some account implementations) can fail `eth_estimateUserOperationGas`
  // when gas fields are zero during simulation, producing `ExecuteError(..., 0x)`.
  // Providing explicit gas limits skips gas estimation in `prepareUserOperation`.
  const userOpGasOverrides = {
    callGasLimit: 1_200_000n,
    verificationGasLimit: 1_200_000n,
    preVerificationGas: 120_000n,
    ...(usePaymaster
      ? {
          paymasterVerificationGasLimit: 400_000n,
          paymasterPostOpGasLimit: 80_000n,
        }
      : {}),
  };

  let txHash;
  const calls = [
    ...(shouldWrapEthToWeth
      ? [
          {
            to: WETH,
            value: amountIn,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: "deposit",
              args: [],
            }),
          },
        ]
      : []),
    { to: WETH, value: 0n, data: approveData },
    { to: SWAP_ROUTER02, value: 0n, data: swapData },
  ];

  if (!isDelegated) {
    // First time: include 7702 authorization to set EOA code to the implementation
    const nonce = await publicClient.getTransactionCount({
      address: owner.address,
    });

    txHash = await smartAccountClient.sendTransaction({
      calls,
      ...userOpGasOverrides,
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
      ...userOpGasOverrides,
    });
  }

  console.log("sent, bundle tx hash:", txHash);

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  const userOp = await diagnoseBundleTx({ publicClient, bundleTxHash: txHash });

  const wethAfter = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner.address],
  });
  const usdcAfter = await publicClient.readContract({
    address: USDCe,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner.address],
  });

  console.log("\nBalances (raw units)");
  console.log("WETH", {
    before: wethBalance.toString(),
    after: wethAfter.toString(),
  });
  console.log("USDCe", {
    before: usdcBefore.toString(),
    after: usdcAfter.toString(),
  });

  if (userOp && userOp.success === false) {
    console.log(
      "\nUserOperation failed (bundle tx can still be SUCCESS on-chain). No swap occurs in this case.",
    );
  }
}

main().catch((e) => {
  const revertData = extractRevertData(e);
  if (revertData) tryDecodeExecuteError(revertData);

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
