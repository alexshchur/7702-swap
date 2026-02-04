import { decodeErrorResult } from "viem";

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

export function extractRevertData(err) {
  const candidates = [
    err?.data,
    err?.cause?.data,
    err?.cause?.cause?.data,
    err?.details,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x")) {
      return candidate;
    }
  }

  const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  const match = text.match(/(0x[0-9a-fA-F]{8,})/);
  return match?.[1];
}

export function tryDecodeExecuteError(revertData) {
  if (
    !revertData ||
    typeof revertData !== "string" ||
    !revertData.startsWith("0x")
  ) {
    return;
  }

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
        "Inner revert data is empty (target reverted without reason). ",
      );
    }
  } catch {
    // ignore
  }
}
