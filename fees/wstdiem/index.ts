import { Adapter, FetchOptions, FetchResultV2 } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { METRIC } from "../../helpers/metrics";

// wstDIEM — Base. Child of Liquid Protocol.
// wstDIEM is an ERC-4626 vault over DIEM (Venice.ai's inference-credit token). The vault stakes its DIEM on
// Venice; the daily inference credit that stake earns is sold for USDC on inference marketplaces (Surplus,
// AntSeed), and venue adapters swap that USDC to DIEM and credit it back into the vault:
//   - creditDIEM(amount)          -> holders' leg: raises totalAssets() without minting shares, so the share
//                                    price rises. The vault mints yieldFeeBps of `amount` to the treasury as
//                                    wstDIEM (priced before the credit lands).
//   - creditWstDIEM(amount, self) -> adapter operator leg (operatorFeeBps): mints wstDIEM to the adapter,
//                                    which is owned by the protocol Safe.
// Deposits pay depositFeeBps, minted to the treasury as wstDIEM.
// Every amount is in DIEM; treasury fee shares are converted to DIEM at the window's opening share price.
// The swap cost (USDC -> WETH -> DIEM on Uniswap V3) goes to Uniswap LPs and is not counted.

const VAULT = "0xe49FA849cB37b0e7A42B2335e333fb99474167ba"; // wstDIEM (InferenceVault v6)
const DIEM = "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"; // Venice DIEM
const TREASURY = "0x2AfE303f4AbD285631872c5A971e5D32fBF1E087"; // receives yield + deposit fees as wstDIEM

const DIEM_CREDITED = "event DIEMCredited(address indexed adapter, uint256 amount)";
const WSTDIEM_CREDITED = "event WstDIEMCredited(address indexed source, address indexed recipient, uint256 diem, uint256 shares)";
const DEPOSIT = "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)";
const TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 value)";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (a: string) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");

const LABELS = {
  YIELD: "Venice Inference Yield",
  YIELD_TO_HOLDERS: "Venice Inference Yield To wstDIEM Holders",
  YIELD_FEE: "Venice Inference Yield Fee To Treasury",
  OPERATOR_FEE: "Venice Inference Yield To Adapter Operator",
  DEPOSIT_FEES: METRIC.DEPOSIT_WITHDRAW_FEES,
  DEPOSIT_FEES_TO_TREASURY: "Deposit Fees To Treasury",
};

const fetch = async (options: FetchOptions): Promise<FetchResultV2> => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailyProtocolRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const [credited, wstCredited, deposits, treasuryMints, pps] = await Promise.all([
    options.getLogs({ target: VAULT, eventAbi: DIEM_CREDITED, entireLog: true, parseLog: true }),
    options.getLogs({ target: VAULT, eventAbi: WSTDIEM_CREDITED, entireLog: true, parseLog: true }),
    options.getLogs({ target: VAULT, eventAbi: DEPOSIT, entireLog: true, parseLog: true }),
    options.getLogs({
      target: VAULT,
      eventAbi: TRANSFER,
      topics: [TRANSFER_TOPIC, topicAddress("0x0000000000000000000000000000000000000000"), topicAddress(TREASURY)],
      entireLog: true,
      parseLog: true,
    }),
    // DIEM per wstDIEM (1e18-scaled) at the start of the window, used to value treasury fee shares.
    options.fromApi.call({ target: VAULT, abi: "function convertToAssets(uint256) view returns (uint256)", params: ["1000000000000000000"] }),
  ]);

  const tx = (log: any) => String(log.transactionHash).toLowerCase();
  const sharesToDiem = (shares: any) => ((BigInt(shares) * BigInt(pps)) / 10n ** 18n).toString();

  // Holders' leg: DIEM credited to raise the share price.
  const creditTxs = new Set<string>();
  for (const log of credited) {
    creditTxs.add(tx(log));
    dailyFees.add(DIEM, log.args[1], LABELS.YIELD);
    dailySupplySideRevenue.add(DIEM, log.args[1], LABELS.YIELD_TO_HOLDERS);
  }

  // Adapter operator leg: DIEM credited as wstDIEM to the (Safe-owned) adapter.
  for (const log of wstCredited) {
    dailyFees.add(DIEM, log.args[2], LABELS.YIELD);
    dailyRevenue.add(DIEM, log.args[2], LABELS.OPERATOR_FEE);
    dailyProtocolRevenue.add(DIEM, log.args[2], LABELS.OPERATOR_FEE);
  }

  // Shares the treasury minted to itself as a depositor are not fees; drop one matching mint per such deposit.
  const ownDeposits = new Map<string, string[]>();
  const depositTxs = new Set<string>();
  for (const log of deposits) {
    depositTxs.add(tx(log));
    if (String(log.args[1]).toLowerCase() === TREASURY.toLowerCase()) {
      const list = ownDeposits.get(tx(log)) ?? [];
      list.push(String(log.args[3]));
      ownDeposits.set(tx(log), list);
    }
  }

  for (const log of treasuryMints) {
    const hash = tx(log);
    const shares = String(log.args[2]);
    if (creditTxs.has(hash)) {
      // Yield fee: carved out of the holders' leg, so it moves from supply side to revenue under the same source.
      const diem = sharesToDiem(shares);
      dailySupplySideRevenue.subtractToken(DIEM, diem, LABELS.YIELD_TO_HOLDERS);
      dailyRevenue.add(DIEM, diem, LABELS.YIELD_FEE);
      dailyProtocolRevenue.add(DIEM, diem, LABELS.YIELD_FEE);
    } else if (depositTxs.has(hash)) {
      const own = ownDeposits.get(hash);
      const i = own ? own.indexOf(shares) : -1;
      if (i >= 0) { own!.splice(i, 1); continue; }
      const diem = sharesToDiem(shares);
      dailyFees.add(DIEM, diem, LABELS.DEPOSIT_FEES);
      dailyRevenue.add(DIEM, diem, LABELS.DEPOSIT_FEES_TO_TREASURY);
      dailyProtocolRevenue.add(DIEM, diem, LABELS.DEPOSIT_FEES_TO_TREASURY);
    }
  }

  return { dailyFees, dailyRevenue, dailyProtocolRevenue, dailySupplySideRevenue };
};

const methodology = {
  Fees: "Venice inference yield earned by the DIEM the vault stakes (inference credit sold for USDC and swapped back to DIEM by the venue adapters, then credited via creditDIEM and creditWstDIEM), plus deposit fees.",
  Revenue: "Adapter operator fee (10% until 2026-07-16, then 5%; owner-set, being lowered to 0%), 5% yield fee on every creditDIEM, and the deposit fee (2.5% until 2026-10-22, then 0.05%), all paid to the protocol as wstDIEM.",
  ProtocolRevenue: "Same as revenue: everything retained by the protocol treasury / Safe-owned adapters.",
  SupplySideRevenue: "Inference yield that reaches wstDIEM holders through a higher share price (creditDIEM net of the 5% yield fee).",
};

const breakdownMethodology = {
  Fees: {
    [LABELS.YIELD]: "DIEM credited to the vault by the venue adapters from sold Venice inference credit (both the holders' leg and the operator leg).",
    [LABELS.DEPOSIT_FEES]: "Deposit fee minted to the treasury as wstDIEM on each deposit (2.5% until 2026-10-22, then 0.05%).",
  },
  Revenue: {
    [LABELS.OPERATOR_FEE]: "Operator leg credited as wstDIEM to the Safe-owned venue adapter (operatorFeeBps: 10% until 2026-07-16, then 5%).",
    [LABELS.YIELD_FEE]: "5% of every creditDIEM, minted to the treasury as wstDIEM (yieldFeeBps = 500).",
    [LABELS.DEPOSIT_FEES_TO_TREASURY]: "Deposit fee minted to the treasury as wstDIEM.",
  },
  ProtocolRevenue: {
    [LABELS.OPERATOR_FEE]: "Operator leg credited as wstDIEM to the Safe-owned venue adapter.",
    [LABELS.YIELD_FEE]: "5% of every creditDIEM, minted to the treasury as wstDIEM.",
    [LABELS.DEPOSIT_FEES_TO_TREASURY]: "Deposit fee minted to the treasury as wstDIEM.",
  },
  SupplySideRevenue: {
    [LABELS.YIELD_TO_HOLDERS]: "creditDIEM amount net of the yield fee; raises the wstDIEM share price for all holders.",
  },
};

const adapter: Adapter = {
  version: 2,
  pullHourly: true,
  chains: [CHAIN.BASE],
  start: "2026-06-10", // InferenceVault v6 deployment
  fetch,
  methodology,
  breakdownMethodology,
};

export default adapter;
