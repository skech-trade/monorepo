// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISkechIOU} from "./interfaces/ISkechIOU.sol";
import {IUSDCAuthorization} from "./interfaces/IUSDCAuthorization.sol";
import {SkechLadder} from "./SkechLadder.sol";

/// @title SkechGame
/// @notice skech, on chain: draw ink ahead of the Bitcoin price, and the ink the price runs through pays.
///
/// The house holds no money. Players deposit USDC; every stake goes into one pool; every hit is paid from it.
/// The house takes 4% of every stake and 10% of every profit, into `SkechRevenue`, and nothing else. When
/// the pool cannot pay a hit, the winner is issued `SkechIOU`, a debt that grows every block and is paid off,
/// by anyone, as the pool refills.
///
/// What goes on chain, and who vouches for it:
///
/// - A **piece** of a drawing is signed by the player's session key: where the ink is (bands of price, by second),
///   what each band stakes, what a dot costs, the second it opens on, the price the player was looking at and
///   the difficulty they were shown. The player's own signature is the only thing that can spend their balance.
/// - A **quote** is signed by the oracle (the engine): when it received each piece, the market's price and
///   momentum on the opening second, and each band's measured chance. The chance is measured off chain, on
///   thousands of real price paths; it cannot be measured here.
/// - The **ladder** is here: from the chance, the difficulty set on this contract and the momentum, the rung
///   each band pays is computed on chain (`SkechLadder`). The engine cannot pay a band more than its chance earns.
/// - A **bar** is the price's second, signed by the oracle: from the second before's close to its high and low.
///   Bars are stored once each and settle every band in that second, hit or miss, by one rule.
///
/// A piece must reach the engine before its opening second, and land here before that second is over, so
/// nothing is bet on a price already seen. Ink counts from the second after opening, up to thirty seconds ahead.
///
/// Sessions: a player registers a key (an Ethereum key, or a P-256 key the browser keeps and cannot export)
/// with one signature from their wallet. The key can place pieces, up to an allowance, until it expires. It
/// can never withdraw: only the wallet can.
///
/// Prices carry 8 decimals, USDC 6, time is in milliseconds on the exchange's clock, chances are in billionths.
contract SkechGame is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    NoncesUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /* ------------------------------------------------------------------ */
    /* Types                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice A band of price in one second of a piece: from `lo` to `hi` (8 decimals, on the grid), `second`
    /// seconds after the piece opens, staking `stake` USDC. A hit pays `stake` times its rung.
    struct Section {
        uint8 second;
        uint64 lo;
        uint64 hi;
        uint64 stake;
    }

    /// @notice What a player signs: a piece of a drawing, bet as it is drawn.
    struct Piece {
        address player;
        /// @dev The drawing this piece is part of, and its number within it: together they name the bet.
        uint64 drawing;
        uint32 index;
        uint8 market;
        /// @dev The difficulty the player was shown. If the market's has changed since, the piece is refused.
        uint8 difficulty;
        /// @dev The second it opens on, ms. Its bands are 1 to 30 seconds after it.
        uint64 openAt;
        /// @dev What one dot costs, USDC.
        uint64 perDot;
        /// @dev The price grid the bands sit on, 8 decimals: bands are judged one unit wider each way.
        uint64 unit;
        /// @dev The price on the player's screen when they drew, and its time, as the oracle signed it.
        uint64 priceSeen;
        uint64 priceTime;
        Section[] sections;
        /// @dev keccak256 of the stroke's points, kept as an event.
        bytes32 strokeHash;
    }

    /// @notice A piece with everything that vouches for it.
    struct Placement {
        Piece piece;
        /// @dev By the session key: 65 bytes r‖s‖v for an Ethereum key, 64 bytes r‖s for a P-256 key.
        bytes sessionSig;
        /// @dev The oracle's signature over `Price(market, priceSeen, priceTime)`.
        bytes priceSig;
        /// @dev The stroke's points, whose hash the piece carries.
        bytes stroke;
    }

    /// @notice What the oracle signs over a batch of pieces opening on one second: the market then, and every band's chance.
    struct Quote {
        uint8 market;
        uint64 openAt;
        uint64 unit;
        /// @dev The price the second before `openAt` closed at, and the last three seconds' move in volatilities, x1e6.
        uint64 price;
        int64 momentum;
        /// @dev When the engine received each piece, ms: one per piece.
        uint64[] receivedAt;
        /// @dev Each band's chance, in billionths: every piece's sections in order, one after another.
        uint32[] chances;
    }

    /// @notice One second of the price: from the second before's close to this one's high, low and close.
    struct Bar {
        uint8 market;
        uint64 second;
        uint64 prevClose;
        uint64 high;
        uint64 low;
        uint64 close;
    }

    struct Market {
        bool active;
        uint8 difficulty;
        /// @dev keccak256 of the market's name, as the oracle's `Price` names it: "BTC-USD".
        bytes32 nameHash;
    }

    /// @notice A player's session key. `key` set: an Ethereum key. Otherwise `x`, `y`: a P-256 public key.
    struct Session {
        address key;
        uint40 validUntil;
        /// @dev USDC the session may still stake.
        uint56 allowance;
        bytes32 x;
        bytes32 y;
    }

    /// @dev One bet: a piece as placed. Sections are packed one to a word: second | lo << 8 | hi << 72 | stake << 136 | rung << 200.
    struct Bet {
        address player;
        uint8 market;
        uint8 difficulty;
        uint8 count;
        uint32 liveMask;
        uint32 hitMask;
        uint64 openAt;
        uint64 perDot;
        uint64 unit;
        uint64 stake;
        uint256[32] sections;
    }

    /// @notice What the game looks like from outside.
    struct BetView {
        address player;
        uint8 market;
        uint8 difficulty;
        uint64 openAt;
        uint64 perDot;
        uint64 unit;
        uint64 stake;
        uint32 liveMask;
        uint32 hitMask;
        Section[] sections;
        uint16[] rungs;
    }

    struct Config {
        uint16 feeBps;
        uint16 profitFeeBps;
        uint16 sweepBps;
        uint32 lateMs;
        uint32 placeGraceMs;
        uint32 maxPriceAgeMs;
        uint64 minPerDot;
        uint64 maxPerDot;
        uint64 maxPieceStake;
        uint64 minRedeem;
    }

    /// @notice Why a piece in a batch was not placed. The rest of the batch goes through.
    enum Refusal {
        None,
        Mismatch,
        Replay,
        Difficulty,
        Late,
        StalePrice,
        PerDot,
        Sections,
        PriceSig,
        Stroke,
        Session,
        SessionSig,
        NotOffered,
        Allowance,
        Balance
    }

    /// @custom:storage-location erc7201:skech.game
    struct GameStorage {
        IERC20 usdc;
        ISkechIOU iou;
        address revenue;
        address oracle;
        /// @dev USDC backing live stakes and paying hits: everything deposited that is not a balance or a fee.
        uint64 pool;
        /// @dev Fees taken and not yet collected.
        uint64 fees;
        Config config;
        uint8 marketCount;
        mapping(uint8 => Market) markets;
        mapping(address => uint64) balances;
        mapping(address => Session) sessions;
        mapping(bytes32 => Bet) bets;
    }

    /* ------------------------------------------------------------------ */
    /* Constants                                                           */
    /* ------------------------------------------------------------------ */

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Seconds ahead a band may be.
    uint8 public constant HORIZON = 30;
    /// @notice The least difficulty a market may be set to, as `SkechLadder` prices it.
    uint8 public constant MIN_DIFFICULTY = SkechLadder.MIN_DIFFICULTY;
    /// @notice Sections in one piece, at most.
    uint8 public constant MAX_SECTIONS = 32;

    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(string market,uint256 price,uint64 time)");
    bytes32 public constant BAR_TYPEHASH =
        keccak256("Bar(uint8 market,uint64 second,uint64 prevClose,uint64 high,uint64 low,uint64 close)");
    bytes32 public constant SECTION_TYPEHASH = keccak256("Section(uint8 second,uint64 lo,uint64 hi,uint64 stake)");
    bytes32 public constant PIECE_TYPEHASH = keccak256(
        "Piece(address player,uint64 drawing,uint32 index,uint8 market,uint8 difficulty,uint64 openAt,uint64 perDot,uint64 unit,uint64 priceSeen,uint64 priceTime,Section[] sections,bytes32 strokeHash)Section(uint8 second,uint64 lo,uint64 hi,uint64 stake)"
    );
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 market,uint64 openAt,uint64 unit,uint64 price,int64 momentum,bytes32[] pieces,uint64[] receivedAt,uint32[] chances)"
    );
    bytes32 public constant SESSION_TYPEHASH = keccak256(
        "Session(address player,uint8 kind,address key,bytes32 x,bytes32 y,uint64 validUntil,uint64 allowance,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address player,uint64 amount,address to,uint256 nonce,uint256 deadline)");

    // keccak256(abi.encode(uint256(keccak256("skech.game")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE = 0xf8cdf277c1dee82b808ef4977285f6a5b9934cf12bad104f17f251bc2b63ec00;
    bytes32 private constant BARS_SALT = keccak256("skech.game.bars");

    uint256 private constant BPS = 10_000;

    /* ------------------------------------------------------------------ */
    /* Events and errors                                                   */
    /* ------------------------------------------------------------------ */

    event Deposited(address indexed player, address indexed from, uint64 amount);
    event Withdrawn(address indexed player, address indexed to, uint64 amount);
    event SessionSet(address indexed player, uint8 kind, address key, bytes32 x, bytes32 y, uint64 validUntil, uint64 allowance);
    event SessionRevoked(address indexed player);
    /// @notice A piece went in. `sections` are packed as stored; `refunded` is the stake of bands not offered.
    event Placed(
        bytes32 indexed betId,
        address indexed player,
        uint8 market,
        uint64 openAt,
        uint64 perDot,
        uint64 unit,
        uint64 staked,
        uint64 fee,
        uint64 refunded,
        uint64 priceSeen,
        uint64 priceTime,
        uint256[] sections
    );
    /// @notice The stroke's points, as the player drew them.
    event Stroke(bytes32 indexed betId, bytes points);
    event Refused(bytes32 indexed betId, address indexed player, uint64 drawing, uint32 index, Refusal why);
    event BarPosted(uint8 indexed market, uint64 indexed second, uint64 prevClose, uint64 high, uint64 low, uint64 close);
    /// @notice Bands decided: `paid` USDC into the balance, `owed` as IOU.
    event Settled(bytes32 indexed betId, address indexed player, uint32 hitMask, uint32 missMask, uint64 paid, uint64 owed);
    event Owed(address indexed to, uint64 value, uint256 shares);
    event Redeemed(address indexed holder, address indexed by, uint256 shares, uint64 value, uint64 cut);
    event FeesCollected(uint64 amount);
    event MarketSet(uint8 indexed market, string name, bool active, uint8 difficulty);
    event DifficultySet(uint8 indexed market, uint8 difficulty);
    event OracleSet(address oracle);
    event ConfigSet(Config config);

    error ZeroAddress();
    error ZeroAmount();
    error Expired();
    error BadSignature();
    error BadSession();
    error BadQuote();
    error NotOracle();
    error MarketInactive();
    error Window();
    error BadBar();
    error BarConflict();
    error BarDiscontinuous();
    error Insufficient();
    error NothingToRedeem();
    error BadConfig();
    error BadDifficulty();

    /* ------------------------------------------------------------------ */
    /* Setup                                                               */
    /* ------------------------------------------------------------------ */

    function _s() private pure returns (GameStorage storage $) {
        assembly {
            $.slot := STORAGE
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin Sets everything, upgrades, pauses. The oracle, relayer and treasurer are all it, for now.
    /// @param oracle_ The engine's wallet: signs prices, bars and quotes.
    function initialize(address admin, address oracle_, IERC20 usdc_, ISkechIOU iou_, address revenue_) external initializer {
        if (
            admin == address(0) || oracle_ == address(0) || address(usdc_) == address(0) || address(iou_) == address(0)
                || revenue_ == address(0)
        ) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("skech", "1");
        __Nonces_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        GameStorage storage $ = _s();
        $.usdc = usdc_;
        $.iou = iou_;
        $.revenue = revenue_;
        $.oracle = oracle_;
        emit OracleSet(oracle_);
        _setConfig(
            Config({
                feeBps: 400,
                profitFeeBps: 1000,
                sweepBps: 1000,
                lateMs: 200,
                placeGraceMs: 3000,
                maxPriceAgeMs: 15_000,
                minPerDot: 10_000, // 1 cent
                maxPerDot: 100_000_000, // $100
                maxPieceStake: 10_000_000_000, // $10,000
                minRedeem: 10_000
            })
        );
        _setMarket(0, "BTC-USD", true, 51);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /* ------------------------------------------------------------------ */
    /* Admin                                                               */
    /* ------------------------------------------------------------------ */

    function setOracle(address oracle_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle_ == address(0)) revert ZeroAddress();
        _s().oracle = oracle_;
        emit OracleSet(oracle_);
    }

    /// @notice Add or change a market. Its `name` must be what the oracle's `Price` calls it.
    function setMarket(uint8 id, string calldata name, bool active, uint8 difficulty) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMarket(id, name, active, difficulty);
    }

    /// @notice How hard the game is on `market`, 50 to 100: pieces placed from now on pay by it. Pieces already open keep
    /// theirs. Below 50, ink exactly on a rung would return more than a dollar.
    function setDifficulty(uint8 market, uint8 difficulty) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (difficulty < SkechLadder.MIN_DIFFICULTY || difficulty > 100) revert BadDifficulty();
        GameStorage storage $ = _s();
        if ($.markets[market].nameHash == bytes32(0)) revert MarketInactive();
        $.markets[market].difficulty = difficulty;
        emit DifficultySet(market, difficulty);
    }

    function setConfig(Config calldata config_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(config_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _setMarket(uint8 id, string memory name, bool active, uint8 difficulty) private {
        if (difficulty < SkechLadder.MIN_DIFFICULTY || difficulty > 100) revert BadDifficulty();
        if (bytes(name).length == 0) revert BadConfig();
        GameStorage storage $ = _s();
        if ($.markets[id].nameHash == bytes32(0)) $.marketCount++;
        $.markets[id] = Market({active: active, difficulty: difficulty, nameHash: keccak256(bytes(name))});
        emit MarketSet(id, name, active, difficulty);
    }

    function _setConfig(Config memory c) private {
        if (c.feeBps > 2000 || c.profitFeeBps > 5000 || c.sweepBps > 5000) revert BadConfig();
        if (c.minPerDot == 0 || c.minPerDot > c.maxPerDot || c.maxPieceStake == 0) revert BadConfig();
        if (c.placeGraceMs < 1000 || c.placeGraceMs > 10_000 || c.lateMs > 1000) revert BadConfig();
        _s().config = c;
        emit ConfigSet(c);
    }

    /* ------------------------------------------------------------------ */
    /* Money in and out                                                    */
    /* ------------------------------------------------------------------ */

    /// @notice Put USDC into your balance. Approve this contract first.
    function deposit(uint64 amount) external {
        _deposit(msg.sender, msg.sender, amount);
    }

    /// @notice Put USDC into `player`'s balance.
    function depositFor(address player, uint64 amount) external {
        _deposit(msg.sender, player, amount);
    }

    /// @notice Put `owner`'s USDC into their balance on the strength of their permit, so anyone can send the transaction for them.
    /// @dev The permit is tried, not required: if someone spent it first the allowance is already there.
    function depositWithPermit(address owner, uint64 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(_s().usdc)).permit(owner, address(this), amount, deadline, v, r, s) {} catch {}
        _deposit(owner, owner, amount);
    }

    /// @notice Put `owner`'s USDC into their balance on the strength of an EIP-3009 authorization they signed, the way
    /// x402 moves USDC: one signature, no allowance, a random nonce so any number can be in flight at once. USDC carries
    /// it out only for its payee, this contract, so nobody can use the signature anywhere else, and whoever sends the
    /// transaction, the USDC is credited to `owner`.
    /// @param validAfter,validBefore The window the authorization is good for, in seconds, as USDC checks it.
    /// @param nonce 32 random bytes, chosen by whoever signs.
    function depositWithAuthorization(
        address owner,
        uint64 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        if (owner == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        IERC20 token = $.usdc;
        uint256 before = token.balanceOf(address(this));
        IUSDCAuthorization(address(token)).receiveWithAuthorization(owner, address(this), amount, validAfter, validBefore, nonce, signature);
        // Credit what arrived, never what was asked for: a token that moved less, or nothing, credits nothing extra.
        if (token.balanceOf(address(this)) - before != amount) revert Insufficient();
        $.balances[owner] += amount;
        emit Deposited(owner, owner, amount);
    }

    function _deposit(address from, address player, uint64 amount) private whenNotPaused nonReentrant {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        $.usdc.safeTransferFrom(from, address(this), amount);
        $.balances[player] += amount;
        emit Deposited(player, from, amount);
    }

    /// @notice Take USDC out of your balance. Always open, paused or not: a session key cannot do this, only you.
    function withdraw(uint64 amount, address to) external nonReentrant {
        _withdraw(msg.sender, amount, to);
    }

    /// @notice Take USDC out of `player`'s balance on their signed say-so, so anyone can send the transaction for them.
    function withdrawBySig(address player, uint64 amount, address to, uint256 deadline, bytes calldata sig) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, player, amount, to, nonces(player), deadline)));
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, sig)) revert BadSignature();
        _useNonce(player);
        _withdraw(player, amount, to);
    }

    function _withdraw(address player, uint64 amount, address to) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        uint64 held = $.balances[player];
        if (held < amount) revert Insufficient();
        $.balances[player] = held - amount;
        $.usdc.safeTransfer(to, amount);
        emit Withdrawn(player, to, amount);
    }

    /* ------------------------------------------------------------------ */
    /* Sessions                                                            */
    /* ------------------------------------------------------------------ */

    /// @notice Let `key` (kind 0, an Ethereum address) or `x`,`y` (kind 1, a P-256 public key) place pieces for `player`
    /// until `validUntil`, staking at most `allowance` USDC in all, on the player's signature. Replaces any session.
    function registerSession(
        address player,
        uint8 kind,
        address key,
        bytes32 x,
        bytes32 y,
        uint64 validUntil,
        uint64 allowance,
        uint256 deadline,
        bytes calldata sig
    ) external whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        if (kind == 0) {
            if (key == address(0) || x != 0 || y != 0) revert BadSession();
        } else if (kind == 1) {
            if (key != address(0) || !P256.isValidPublicKey(x, y)) revert BadSession();
        } else {
            revert BadSession();
        }
        if (validUntil >= 1 << 40 || allowance >= 1 << 56) revert BadSession();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SESSION_TYPEHASH, player, kind, key, x, y, validUntil, allowance, nonces(player), deadline))
        );
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, sig)) revert BadSignature();
        _useNonce(player);
        _s().sessions[player] = Session({key: key, validUntil: uint40(validUntil), allowance: uint56(allowance), x: x, y: y});
        emit SessionSet(player, kind, key, x, y, validUntil, allowance);
    }

    /// @notice End your session now.
    function revokeSession() external {
        delete _s().sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    /* ------------------------------------------------------------------ */
    /* Placing                                                             */
    /* ------------------------------------------------------------------ */

    /// @notice Place a batch of pieces that open on one second, with the oracle's quote for them. Anyone may send
    /// this: every piece is signed by its player and the quote by the oracle. A piece that cannot go in is
    /// refused with a reason and the rest go in; nothing is charged for a refused piece.
    function place(Placement[] calldata placements, Quote calldata quote, bytes calldata quoteSig) external whenNotPaused {
        GameStorage storage $ = _s();
        uint256 n = placements.length;
        if (n == 0 || quote.receivedAt.length != n) revert BadQuote();
        Market storage market = $.markets[quote.market];
        if (!market.active) revert MarketInactive();
        if (quote.openAt % 1000 != 0 || quote.unit == 0 || quote.price == 0) revert BadQuote();
        // A grid unit is a sliver of the price: it also pads every band, so it cannot be let grow.
        if (uint256(quote.unit) * 2000 > quote.price) revert BadQuote();
        // Inside the window: not long after the second the pieces open on, and not before it either.
        uint256 nowMs = block.timestamp * 1000;
        uint32 grace = $.config.placeGraceMs;
        if (nowMs > quote.openAt + grace || quote.openAt > nowMs + grace) revert Window();

        bytes32[] memory hashes = new bytes32[](n);
        uint256 bands;
        for (uint256 i = 0; i < n; i++) {
            hashes[i] = hashPiece(placements[i].piece);
            bands += placements[i].piece.sections.length;
        }
        if (quote.chances.length != bands) revert BadQuote();
        bytes32 qh = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote.market,
                quote.openAt,
                quote.unit,
                quote.price,
                quote.momentum,
                keccak256(abi.encodePacked(hashes)),
                keccak256(abi.encodePacked(quote.receivedAt)),
                keccak256(abi.encodePacked(quote.chances))
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(qh), quoteSig) != $.oracle) revert NotOracle();

        uint256 cursor;
        uint256 pooled;
        uint256 taken;
        for (uint256 i = 0; i < n; i++) {
            uint256 count = placements[i].piece.sections.length;
            (uint64 staked, uint64 fee) =
                _place(placements[i], hashes[i], quote, market, quote.receivedAt[i], quote.chances[cursor:cursor + count]);
            cursor += count;
            pooled += staked - fee;
            taken += fee;
        }
        $.pool += uint64(pooled);
        $.fees += uint64(taken);
    }

    /// @dev One piece. Returns what it staked (after fees, into the pool) and the fee; both zero if refused.
    function _place(
        Placement calldata pl,
        bytes32 pieceHash,
        Quote calldata q,
        Market storage market,
        uint64 receivedAt,
        uint32[] calldata chances
    ) private returns (uint64 staked, uint64 fee) {
        Piece calldata p = pl.piece;
        bytes32 betId = keccak256(abi.encodePacked(p.player, p.drawing, p.index));
        Refusal why = _check(p, pl, betId, pieceHash, q, market, receivedAt);
        if (why != Refusal.None) {
            emit Refused(betId, p.player, p.drawing, p.index, why);
            return (0, 0);
        }
        GameStorage storage $ = _s();
        uint256 total;
        uint256 kept;
        uint256[] memory packed = new uint256[](p.sections.length);
        uint8 count;
        for (uint256 i = 0; i < p.sections.length; i++) {
            Section calldata s = p.sections[i];
            total += s.stake;
            // Not offered: its second is already over on chain, or its chance earns no rung. Its stake is not taken.
            if (_bar(q.market, p.openAt + uint64(s.second) * 1000) != 0) continue;
            uint16 rung = SkechLadder.rungFor(chances[i], p.difficulty, _withIt(s, q), q.momentum);
            if (rung == 0) continue;
            // One section never pays past 256 dots: a big one stakes only what that pays for.
            uint64 stake = s.stake;
            uint64 most = SkechLadder.maxStake(p.perDot, rung);
            if (stake > most) stake = most;
            packed[count] = uint256(s.second) | (uint256(s.lo) << 8) | (uint256(s.hi) << 72) | (uint256(stake) << 136)
                | (uint256(rung) << 200);
            kept += stake;
            count++;
        }
        if (kept == 0) {
            emit Refused(betId, p.player, p.drawing, p.index, Refusal.NotOffered);
            return (0, 0);
        }
        Session storage session = $.sessions[p.player];
        if (session.allowance < kept) {
            emit Refused(betId, p.player, p.drawing, p.index, Refusal.Allowance);
            return (0, 0);
        }
        uint64 held = $.balances[p.player];
        if (held < kept) {
            emit Refused(betId, p.player, p.drawing, p.index, Refusal.Balance);
            return (0, 0);
        }
        // Everything checks out: only now is anything written.
        staked = uint64(kept);
        fee = uint64((kept * $.config.feeBps) / BPS);
        $.balances[p.player] = held - staked;
        session.allowance -= uint56(kept);
        Bet storage b = $.bets[betId];
        for (uint256 i = 0; i < count; i++) {
            b.sections[i] = packed[i];
        }
        b.player = p.player;
        b.market = p.market;
        b.difficulty = p.difficulty;
        b.count = count;
        b.liveMask = uint32((1 << count) - 1);
        b.openAt = p.openAt;
        b.perDot = p.perDot;
        b.unit = p.unit;
        b.stake = staked;
        assembly {
            mstore(packed, count)
        }
        emit Placed(betId, p.player, p.market, p.openAt, p.perDot, p.unit, staked, fee, uint64(total - kept), p.priceSeen, p.priceTime, packed);
        emit Stroke(betId, pl.stroke);
    }

    /// @dev Everything about a piece that can be wrong before its bands are priced.
    function _check(
        Piece calldata p,
        Placement calldata pl,
        bytes32 betId,
        bytes32 pieceHash,
        Quote calldata q,
        Market storage market,
        uint64 receivedAt
    ) private view returns (Refusal) {
        GameStorage storage $ = _s();
        Config storage c = $.config;
        if (p.market != q.market || p.openAt != q.openAt || p.unit != q.unit) return Refusal.Mismatch;
        if ($.bets[betId].player != address(0)) return Refusal.Replay;
        if (p.difficulty != market.difficulty) return Refusal.Difficulty;
        // The engine must have had the piece before its opening second, give or take the network.
        if (receivedAt > p.openAt + c.lateMs) return Refusal.Late;
        if (p.priceTime > receivedAt || receivedAt - p.priceTime > c.maxPriceAgeMs) return Refusal.StalePrice;
        if (p.perDot < c.minPerDot || p.perDot > c.maxPerDot) return Refusal.PerDot;
        uint256 n = p.sections.length;
        if (n == 0 || n > MAX_SECTIONS) return Refusal.Sections;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            Section calldata s = p.sections[i];
            if (s.second == 0 || s.second > HORIZON || s.lo >= s.hi || s.stake == 0) return Refusal.Sections;
            if (s.lo % p.unit != 0 || s.hi % p.unit != 0) return Refusal.Sections;
            total += s.stake;
        }
        if (total > c.maxPieceStake) return Refusal.Sections;
        if (keccak256(pl.stroke) != p.strokeHash) return Refusal.Stroke;
        // The price the player saw: signed by the oracle, for this market.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(
            _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, market.nameHash, uint256(p.priceSeen), p.priceTime))),
            pl.priceSig
        );
        if (err != ECDSA.RecoverError.NoError || signer != $.oracle) return Refusal.PriceSig;
        Session storage session = $.sessions[p.player];
        if (session.validUntil <= block.timestamp) return Refusal.Session;
        bytes32 digest = _hashTypedDataV4(pieceHash);
        if (session.key != address(0)) {
            (address k, ECDSA.RecoverError e,) = ECDSA.tryRecover(digest, pl.sessionSig);
            if (e != ECDSA.RecoverError.NoError || k != session.key) return Refusal.SessionSig;
        } else {
            // WebCrypto signs SHA-256 of what it is given: the digest.
            if (pl.sessionSig.length != 64) return Refusal.SessionSig;
            bytes32 r = bytes32(pl.sessionSig[0:32]);
            bytes32 s = bytes32(pl.sessionSig[32:64]);
            if (!P256.verify(sha256(abi.encodePacked(digest)), r, s, session.x, session.y)) return Refusal.SessionSig;
        }
        return Refusal.None;
    }

    /// @dev Whether a band is on the side the price has just moved toward, where the momentum margin comes off.
    function _withIt(Section calldata s, Quote calldata q) private pure returns (bool) {
        uint256 mid = (uint256(s.lo) + uint256(s.hi)) / 2;
        return (mid > q.price && q.momentum > 0) || (mid < q.price && q.momentum < 0);
    }

    /* ------------------------------------------------------------------ */
    /* The price, and settling on it                                       */
    /* ------------------------------------------------------------------ */

    /// @notice Record one second of the price, signed by the oracle. Posting the same bar twice is fine; a different one for the same second is not.
    function postBar(Bar calldata bar, bytes calldata sig) external whenNotPaused {
        _postBar(bar, sig);
    }

    /// @notice Record a second of the price and settle the bets that have ink in it: the relayer's one transaction a second.
    function postBarAndSettle(Bar calldata bar, bytes calldata sig, bytes32[] calldata betIds) external whenNotPaused {
        _postBar(bar, sig);
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    /// @notice Record several seconds and settle after them.
    function postBarsAndSettle(Bar[] calldata bars, bytes[] calldata sigs, bytes32[] calldata betIds) external whenNotPaused {
        if (bars.length != sigs.length) revert BadBar();
        for (uint256 i = 0; i < bars.length; i++) {
            _postBar(bars[i], sigs[i]);
        }
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    /// @notice Settle bets on the bars already posted: bands in a posted second are hit or missed; the rest wait.
    function settle(bytes32[] calldata betIds) external whenNotPaused {
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    function _postBar(Bar calldata bar, bytes calldata sig) private {
        GameStorage storage $ = _s();
        if (!$.markets[bar.market].active) revert MarketInactive();
        if (bar.second % 1000 != 0 || bar.low == 0 || bar.prevClose == 0) revert BadBar();
        if (bar.low > bar.high || bar.close < bar.low || bar.close > bar.high) revert BadBar();
        // A second is posted once it is over, by this chain's clock, give or take the grace: never ahead of the ink in it.
        if (bar.second + 1000 > block.timestamp * 1000 + $.config.placeGraceMs) revert BadBar();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(BAR_TYPEHASH, bar.market, bar.second, bar.prevClose, bar.high, bar.low, bar.close))
        );
        if (ECDSA.recover(digest, sig) != $.oracle) revert NotOracle();
        uint256 packed = uint256(bar.prevClose) | (uint256(bar.high) << 64) | (uint256(bar.low) << 128) | (uint256(bar.close) << 192);
        bytes32 slot = _barSlot(bar.market, bar.second);
        uint256 existing;
        assembly {
            existing := sload(slot)
        }
        if (existing != 0) {
            if (existing != packed) revert BarConflict();
            return;
        }
        // One second follows from the last: the previous bar's close is this one's opening price.
        uint256 previous = bar.second >= 1000 ? _bar(bar.market, bar.second - 1000) : 0;
        if (previous != 0 && uint64(previous >> 192) != bar.prevClose) revert BarDiscontinuous();
        assembly {
            sstore(slot, packed)
        }
        emit BarPosted(bar.market, bar.second, bar.prevClose, bar.high, bar.low, bar.close);
    }

    function _settle(bytes32 betId) private {
        GameStorage storage $ = _s();
        Bet storage b = $.bets[betId];
        uint32 live = b.liveMask;
        if (b.player == address(0) || live == 0) return;
        uint8 count = b.count;
        uint64 openAt = b.openAt;
        uint64 unit = b.unit;
        uint8 market = b.market;
        uint32 hits;
        uint32 decided;
        uint256 grossPay;
        uint256 stakeHit;
        for (uint256 i = 0; i < count; i++) {
            uint32 bit = uint32(1 << i);
            if (live & bit == 0) continue;
            uint256 word = b.sections[i];
            uint256 bar = _bar(market, openAt + uint64(uint8(word)) * 1000);
            if (bar == 0) continue;
            decided |= bit;
            // What the price covered in the second: from where the second before closed to its own high and low.
            uint256 prevClose = uint64(bar);
            uint256 high = uint64(bar >> 64);
            uint256 low = uint64(bar >> 128);
            if (prevClose > high) high = prevClose;
            if (prevClose < low) low = prevClose;
            uint256 lo = uint64(word >> 8);
            uint256 hi = uint64(word >> 72);
            // A band is judged one unit wider each way, as it was priced: the ink's own edges, inclusive.
            if (high + unit >= lo && low <= hi + unit) {
                hits |= bit;
                uint64 stake = uint64(word >> 136);
                stakeHit += stake;
                grossPay += SkechLadder.gross(stake, uint16(word >> 200));
            }
        }
        if (decided == 0) return;
        b.liveMask = live & ~decided;
        b.hitMask |= hits;
        uint64 paid;
        uint64 owed;
        if (grossPay > 0) {
            uint256 profit = grossPay - stakeHit;
            uint256 profitFee = (profit * $.config.profitFeeBps) / BPS;
            (paid, owed) = _pay(b.player, uint64(grossPay - profitFee));
            if (profitFee > 0) _pay($.revenue, uint64(profitFee));
        }
        emit Settled(betId, b.player, hits, decided & ~hits, paid, owed);
    }

    /// @dev Pay `due` to `to` from the pool: in USDC as far as it goes, the rest as IOU. Fees for the house go into `fees`.
    function _pay(address to, uint64 due) private returns (uint64 paid, uint64 owed) {
        GameStorage storage $ = _s();
        uint64 available = $.pool;
        paid = due <= available ? due : available;
        if (paid > 0) {
            $.pool = available - paid;
            _credit(to, paid);
        }
        owed = due - paid;
        if (owed > 0) {
            uint256 shares = $.iou.mint(to, owed);
            emit Owed(to, owed, shares);
        }
    }

    function _credit(address to, uint64 amount) private {
        GameStorage storage $ = _s();
        if (to == $.revenue) $.fees += amount;
        else $.balances[to] += amount;
    }

    /* ------------------------------------------------------------------ */
    /* IOUs and fees                                                       */
    /* ------------------------------------------------------------------ */

    /// @notice Pay off `holder`'s IOU, as much of `shares` as the pool can cover, into their balance. Anyone may do
    /// this, and is paid a share of the growth for it; a holder redeeming their own pays nothing.
    function redeem(address holder, uint256 shares) external whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        ISkechIOU token = $.iou;
        uint256 held = token.balanceOf(holder);
        if (shares > held) shares = held;
        if (shares == 0) revert NothingToRedeem();
        uint64 value = token.valueOf(shares);
        uint64 available = $.pool;
        if (value > available) {
            // What the pool can pay now; the rest stays owed, and keeps growing.
            shares = (shares * available) / value;
            value = token.valueOf(shares);
        }
        if (shares == 0 || value == 0) revert NothingToRedeem();
        if (shares < held && value < $.config.minRedeem) revert NothingToRedeem();
        (uint64 v, uint64 basis) = token.burn(holder, shares);
        if (v > available) revert Insufficient();
        $.pool = available - v;
        uint64 growth = v > basis ? v - basis : 0;
        uint64 cut = msg.sender == holder ? 0 : uint64((uint256(growth) * $.config.sweepBps) / BPS);
        _credit(holder, v - cut);
        if (cut > 0) _credit(msg.sender, cut);
        emit Redeemed(holder, msg.sender, shares, v, cut);
    }

    /// @notice Move the fees taken so far to the revenue holder. Anyone may.
    function collectFees() external nonReentrant returns (uint64 amount) {
        GameStorage storage $ = _s();
        amount = $.fees;
        if (amount == 0) return 0;
        $.fees = 0;
        $.usdc.safeTransfer($.revenue, amount);
        emit FeesCollected(amount);
    }

    /* ------------------------------------------------------------------ */
    /* Reading                                                             */
    /* ------------------------------------------------------------------ */

    function balanceOf(address player) external view returns (uint64) {
        return _s().balances[player];
    }

    function sessionOf(address player) external view returns (Session memory) {
        return _s().sessions[player];
    }

    function pool() external view returns (uint64) {
        return _s().pool;
    }

    function fees() external view returns (uint64) {
        return _s().fees;
    }

    function oracle() external view returns (address) {
        return _s().oracle;
    }

    function usdc() external view returns (IERC20) {
        return _s().usdc;
    }

    function iou() external view returns (ISkechIOU) {
        return _s().iou;
    }

    function revenue() external view returns (address) {
        return _s().revenue;
    }

    function config() external view returns (Config memory) {
        return _s().config;
    }

    function marketOf(uint8 id) external view returns (Market memory) {
        return _s().markets[id];
    }

    function difficultyOf(uint8 market) external view returns (uint8) {
        return _s().markets[market].difficulty;
    }

    /// @notice The bet a piece became.
    function betOf(bytes32 betId) external view returns (BetView memory v) {
        Bet storage b = _s().bets[betId];
        v.player = b.player;
        v.market = b.market;
        v.difficulty = b.difficulty;
        v.openAt = b.openAt;
        v.perDot = b.perDot;
        v.unit = b.unit;
        v.stake = b.stake;
        v.liveMask = b.liveMask;
        v.hitMask = b.hitMask;
        v.sections = new Section[](b.count);
        v.rungs = new uint16[](b.count);
        for (uint256 i = 0; i < b.count; i++) {
            uint256 w = b.sections[i];
            v.sections[i] = Section({second: uint8(w), lo: uint64(w >> 8), hi: uint64(w >> 72), stake: uint64(w >> 136)});
            v.rungs[i] = uint16(w >> 200);
        }
    }

    /// @notice The name of a piece's bet.
    function betIdOf(address player, uint64 drawing, uint32 index) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(player, drawing, index));
    }

    /// @notice The bar for `second` (ms) on `market`, all zero if not posted.
    function barAt(uint8 market, uint64 second) external view returns (uint64 prevClose, uint64 high, uint64 low, uint64 close) {
        uint256 bar = _bar(market, second);
        return (uint64(bar), uint64(bar >> 64), uint64(bar >> 128), uint64(bar >> 192));
    }

    /// @notice The rung, x100, a band earns here: the ladder is on chain. Zero when not offered.
    function rungFor(uint8 market, uint32 chanceE9, bool withIt, int64 momentumE6) external view returns (uint16) {
        return SkechLadder.rungFor(chanceE9, _s().markets[market].difficulty, withIt, momentumE6);
    }

    /// @notice The EIP-712 struct hash of a piece: what a session key signs, under this contract's domain.
    function hashPiece(Piece calldata p) public pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](p.sections.length);
        for (uint256 i = 0; i < h.length; i++) {
            Section calldata s = p.sections[i];
            h[i] = keccak256(abi.encode(SECTION_TYPEHASH, s.second, s.lo, s.hi, s.stake));
        }
        return keccak256(
            abi.encode(
                PIECE_TYPEHASH,
                p.player,
                p.drawing,
                p.index,
                p.market,
                p.difficulty,
                p.openAt,
                p.perDot,
                p.unit,
                p.priceSeen,
                p.priceTime,
                keccak256(abi.encodePacked(h)),
                p.strokeHash
            )
        );
    }

    /// @notice The digest a session key signs for `p`.
    function pieceDigest(Piece calldata p) external view returns (bytes32) {
        return _hashTypedDataV4(hashPiece(p));
    }

    /// @notice The digest the oracle signs for a quote over these pieces.
    function quoteDigest(Quote calldata quote, bytes32[] calldata pieces) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    quote.market,
                    quote.openAt,
                    quote.unit,
                    quote.price,
                    quote.momentum,
                    keccak256(abi.encodePacked(pieces)),
                    keccak256(abi.encodePacked(quote.receivedAt)),
                    keccak256(abi.encodePacked(quote.chances))
                )
            )
        );
    }

    /// @notice The digest a player's wallet signs to register a session.
    function sessionDigest(
        address player,
        uint8 kind,
        address key,
        bytes32 x,
        bytes32 y,
        uint64 validUntil,
        uint64 allowance,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SESSION_TYPEHASH, player, kind, key, x, y, validUntil, allowance, nonces(player), deadline))
        );
    }

    /// @notice The digest a player's wallet signs to withdraw through someone else's transaction.
    function withdrawDigest(address player, uint64 amount, address to, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, player, amount, to, nonces(player), deadline)));
    }

    function barDigest(Bar calldata bar) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(BAR_TYPEHASH, bar.market, bar.second, bar.prevClose, bar.high, bar.low, bar.close))
        );
    }

    function priceDigest(string calldata market, uint256 price, uint64 time) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, keccak256(bytes(market)), price, time)));
    }

    /* ------------------------------------------------------------------ */
    /* Bars: one slot per second, consecutive, so a run of seconds shares a storage page                           */
    /* ------------------------------------------------------------------ */

    function _barSlot(uint8 market, uint64 second) private pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(BARS_SALT, market))) + second / 1000);
    }

    function _bar(uint8 market, uint64 second) private view returns (uint256 bar) {
        bytes32 slot = _barSlot(market, second);
        assembly {
            bar := sload(slot)
        }
    }
}
