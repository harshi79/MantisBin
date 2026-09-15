/**
 * Dependency-free QR sharing helpers.
 *
 * This is a small byte-mode QR encoder for canonical paste URLs. It supports
 * QR error-correction level L and versions 1–40, which is more than enough for
 * normal MantisBin origins and line anchors. No paste content, title or secret
 * is passed to the encoder — the caller gives it one URL string.
 */

const encoder = new TextEncoder();
const QUIET_ZONE = 4;
const ECC_LEVEL_L = 1; // format information value for level L (01)

// Nayuki/QR-spec tables for error correction level L. The raw module formula
// below derives the total codewords; these two compact tables provide the block
// layout without a dependency or a large generated asset.
const ECC_CODEWORDS_PER_BLOCK_L = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 26, 30, 28, 28, 26, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const NUM_ERROR_CORRECTION_BLOCKS_L = [
  0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
];

const alignmentPositions = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
let gfValue = 1;
for (let i = 0; i < 255; i++) {
  GF_EXP[i] = gfValue;
  GF_LOG[gfValue] = i;
  gfValue <<= 1;
  if (gfValue & 0x100) gfValue ^= 0x11d;
}
for (let i = 255; i < GF_EXP.length; i++) GF_EXP[i] = GF_EXP[i - 255];

/** @param {number} a @param {number} b */
function gfMultiply(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** @type {Map<number, number[]>} */
const generatorCache = new Map();

/** @param {number} degree */
function reedSolomonGenerator(degree) {
  const cached = generatorCache.get(degree);
  if (cached) return cached;
  let result = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j++) {
      next[j] ^= result[j];
      next[j + 1] ^= gfMultiply(result[j], GF_EXP[i]);
    }
    result = next;
  }
  generatorCache.set(degree, result);
  return result;
}

/** @param {Uint8Array} data @param {number} degree */
function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(generator[i + 1], factor);
  }
  return result;
}

class BitBuffer {
  constructor() {
    /** @type {number[]} */
    this.bits = [];
  }

  /** @param {number} value @param {number} length */
  append(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Number of raw codewords in a QR version. */
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
  }
  if (version >= 7) result -= 36;
  return Math.floor(result / 8);
}

/** @param {number} version */
function blockLayout(version) {
  const ecc = ECC_CODEWORDS_PER_BLOCK_L[version];
  const blocks = NUM_ERROR_CORRECTION_BLOCKS_L[version];
  const raw = numRawDataModules(version);
  const data = raw - ecc * blocks;
  const shortData = Math.floor(data / blocks);
  const shortBlocks = blocks - (data % blocks);
  return { ecc, blocks, data, shortData, shortBlocks };
}

/** @param {number[]} bytes @param {number} version */
function makeCodewords(bytes, version) {
  const layout = blockLayout(version);
  const countBits = version < 10 ? 8 : 16;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4); // byte mode
  buffer.append(bytes.length, countBits);
  for (const byte of bytes) buffer.append(byte, 8);

  const dataBits = layout.data * 8;
  if (buffer.bits.length > dataBits) throw new Error('QR payload is too large');
  buffer.append(0, Math.min(4, dataBits - buffer.bits.length));
  while (buffer.bits.length % 8) buffer.bits.push(0);
  const dataCodewords = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | buffer.bits[i + j];
    dataCodewords.push(value);
  }
  let pad = 0xec;
  while (dataCodewords.length < layout.data) {
    dataCodewords.push(pad);
    pad ^= 0xec ^ 0x11;
  }

  /** @type {Uint8Array[]} */
  const dataBlocks = [];
  /** @type {Uint8Array[]} */
  const eccBlocks = [];
  let offset = 0;
  for (let block = 0; block < layout.blocks; block++) {
    const length = layout.shortData + (block >= layout.shortBlocks ? 1 : 0);
    const dataBlock = Uint8Array.from(dataCodewords.slice(offset, offset + length));
    offset += length;
    dataBlocks.push(dataBlock);
    eccBlocks.push(reedSolomonRemainder(dataBlock, layout.ecc));
  }

  const result = [];
  const maxDataLength = layout.shortData + (layout.shortBlocks < layout.blocks ? 1 : 0);
  for (let i = 0; i < maxDataLength; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < layout.ecc; i++) for (const block of eccBlocks) result.push(block[i]);
  return result;
}

/** Set a function module, never a data module. */
function setFunction(matrix, row, col, value) {
  if (row >= 0 && row < matrix.length && col >= 0 && col < matrix.length) matrix[row][col] = Boolean(value);
}

function drawFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      setFunction(matrix, row + r, col + c, dark);
    }
  }
}

function drawAlignment(matrix, row, col) {
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) setFunction(matrix, row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
}

function drawFunctionPatterns(matrix, version) {
  const size = matrix.length;
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, size - 7, 0);
  drawFinder(matrix, 0, size - 7);

  const positions = alignmentPositions[version] || [];
  for (const row of positions) {
    for (const col of positions) {
      if (matrix[row][col] !== null) continue;
      drawAlignment(matrix, row, col);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) setFunction(matrix, 6, i, i % 2 === 0);
    if (matrix[i][6] === null) setFunction(matrix, i, 6, i % 2 === 0);
  }

  // Reserve the two 15-bit format areas and the fixed dark module.
  for (let i = 0; i < 15; i++) {
    const verticalRow = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    const horizontalCol = i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i;
    setFunction(matrix, verticalRow, 8, false);
    setFunction(matrix, 8, horizontalCol, false);
  }
  setFunction(matrix, size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      setFunction(matrix, Math.floor(i / 3), (i % 3) + size - 11, false);
      setFunction(matrix, (i % 3) + size - 11, Math.floor(i / 3), false);
    }
  }
}

/** @param {number} value */
function bchDigit(value) {
  let digit = 0;
  while (value !== 0) {
    digit++;
    value >>>= 1;
  }
  return digit;
}

/** @param {number} data */
function bchTypeInfo(data) {
  let value = data << 10;
  const generator = 0x537;
  while (bchDigit(value) >= bchDigit(generator)) value ^= generator << (bchDigit(value) - bchDigit(generator));
  return ((data << 10) | value) ^ 0x5412;
}

/** @param {number} version */
function bchTypeNumber(version) {
  let value = version << 12;
  const generator = 0x1f25;
  while (bchDigit(value) >= bchDigit(generator)) value ^= generator << (bchDigit(value) - bchDigit(generator));
  return (version << 12) | value;
}

/** @param {number} row @param {number} col @param {number} mask */
function maskBit(row, col, mask) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return (row * col) % 2 + (row * col) % 3 === 0;
    case 6: return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
    default: return ((row + col) % 2 + (row * col) % 3) % 2 === 0;
  }
}

/** @param {boolean[][]} matrix @param {number[]} codewords @param {number} version @param {number} mask */
function drawData(matrix, codewords, version, mask) {
  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  let bitIndex = 0;
  let upward = true;
  for (let col = matrix.length - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < matrix.length; i++) {
      const row = upward ? matrix.length - 1 - i : i;
      for (let offset = 0; offset < 2; offset++) {
        const currentCol = col - offset;
        if (matrix[row][currentCol] !== null) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
        matrix[row][currentCol] = Boolean(bit ^ (maskBit(row, currentCol, mask) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  if (bitIndex !== bits.length) throw new Error('QR matrix capacity mismatch');
}

function drawFormatInfo(matrix, mask) {
  const size = matrix.length;
  const bits = bchTypeInfo((ECC_LEVEL_L << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const verticalRow = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    const horizontalCol = i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i;
    matrix[verticalRow][8] = bit;
    matrix[8][horizontalCol] = bit;
  }
  matrix[size - 8][8] = true;
}

function drawVersionInfo(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  const bits = bchTypeNumber(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    matrix[Math.floor(i / 3)][(i % 3) + size - 11] = bit;
    matrix[(i % 3) + size - 11][Math.floor(i / 3)] = bit;
  }
}

/** QR penalty score; used to choose the least patterned mask. */
function penalty(matrix) {
  const size = matrix.length;
  let score = 0;
  const runPenalty = (values) => {
    let runColor = values[0];
    let runLength = 1;
    for (let i = 1; i < values.length; i++) {
      if (values[i] === runColor) runLength++;
      else {
        if (runLength >= 5) score += 3 + runLength - 5;
        runColor = values[i];
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + runLength - 5;
  };
  for (let r = 0; r < size; r++) runPenalty(matrix[r]);
  for (let c = 0; c < size; c++) runPenalty(matrix.map((row) => row[c]));
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (matrix[r][c] === matrix[r + 1][c] && matrix[r][c] === matrix[r][c + 1] && matrix[r][c] === matrix[r + 1][c + 1]) score += 3;
    }
  }
  const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
  const finderLike2 = [false, false, false, false, true, false, true, true, true, false, true];
  const checkSequence = (values) => {
    for (let i = 0; i <= values.length - 11; i++) {
      let first = true;
      let second = true;
      for (let j = 0; j < 11; j++) {
        if (values[i + j] !== finderLike[j]) first = false;
        if (values[i + j] !== finderLike2[j]) second = false;
      }
      if (first || second) score += 40;
    }
  };
  for (let r = 0; r < size; r++) checkSequence(matrix[r]);
  for (let c = 0; c < size; c++) checkSequence(matrix.map((row) => row[c]));
  let dark = 0;
  for (const row of matrix) for (const module of row) if (module) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** @param {number} version @param {number[]} codewords @param {number} mask */
function makeMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  /** @type {boolean[][]} */
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  drawFunctionPatterns(matrix, version);
  drawData(matrix, codewords, version, mask);
  drawFormatInfo(matrix, mask);
  drawVersionInfo(matrix, version);
  return matrix;
}

/**
 * Normalize a line anchor to the only fragment QR links may carry.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLineAnchor(value) {
  const raw = String(value || '').trim().replace(/^#/, '');
  const match = /^(?:line-)?([1-9][0-9]{0,6})$/.exec(raw);
  if (!match) return '';
  const line = Number(match[1]);
  return line >= 1 && line <= 9_999_999 ? `line-${line}` : '';
}

/**
 * Build the one canonical URL a QR code is allowed to contain.
 * @param {string} origin
 * @param {string} id
 * @param {unknown} [line]
 * @returns {string}
 */
export function canonicalPasteUrl(origin, id, line) {
  const base = String(origin || '').replace(/\/+$/, '');
  const pasteId = encodeURIComponent(String(id || ''));
  const anchor = normalizeLineAnchor(line);
  return `${base}/p/${pasteId}${anchor ? `#${anchor}` : ''}`;
}

/**
 * Encode a URL as a QR matrix. The input is intentionally just one string so
 * callers cannot accidentally add content or a password as a second payload.
 * @param {string} value
 * @returns {boolean[][]}
 */
export function qrMatrix(value) {
  const bytes = Array.from(encoder.encode(String(value)));
  let version = 0;
  for (let candidate = 1; candidate <= 40; candidate++) {
    const countBits = candidate < 10 ? 8 : 16;
    const capacity = (numRawDataModules(candidate) - ECC_CODEWORDS_PER_BLOCK_L[candidate] * NUM_ERROR_CORRECTION_BLOCKS_L[candidate]) * 8;
    if (bytes.length < (1 << countBits) && 4 + countBits + bytes.length * 8 <= capacity) {
      version = candidate;
      break;
    }
  }
  if (!version) throw new Error('QR URL is too long');
  const codewords = makeCodewords(bytes, version);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = makeMatrix(version, codewords, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return /** @type {boolean[][]} */ (best);
}

/**
 * Render a QR matrix as a self-contained SVG. The URL is encoded in the bits,
 * not copied into an SVG attribute, so the image itself cannot become an HTML
 * injection vector. The surrounding page supplies the accessible text fallback.
 * @param {string} value canonical URL
 * @returns {string}
 */
export function qrSvg(value) {
  const matrix = qrMatrix(value);
  const size = matrix.length;
  const dimension = size + QUIET_ZONE * 2;
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (matrix[row][col]) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" width="${dimension}" height="${dimension}" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="${dimension}" height="${dimension}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}
