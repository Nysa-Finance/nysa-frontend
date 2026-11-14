import { PROGRAM_ID } from '@kamino-finance/klend-sdk'

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const FLASH_BORROW_DISCRIMINATOR = Uint8Array.from([135, 231, 52, 167, 7, 52, 212, 193])
const FLASH_REPAY_DISCRIMINATOR = Uint8Array.from([185, 117, 0, 203, 96, 245, 180, 186])

function hasDiscriminator(instruction, discriminator) {
  return String(instruction?.programAddress) === String(PROGRAM_ID)
    && instruction.data instanceof Uint8Array
    && instruction.data.length >= discriminator.length
    && discriminator.every((byte, index) => instruction.data[index] === byte)
}

function flashInstructionIndexes(instructions) {
  const borrowIndexes = [], repayIndexes = []
  instructions.forEach((instruction, index) => {
    if (hasDiscriminator(instruction, FLASH_BORROW_DISCRIMINATOR)) borrowIndexes.push(index)
    if (hasDiscriminator(instruction, FLASH_REPAY_DISCRIMINATOR)) repayIndexes.push(index)
  })
  return { borrowIndexes, repayIndexes }
}

export function isAssociatedTokenCreate(instruction) {
  return String(instruction?.programAddress) === ASSOCIATED_TOKEN_PROGRAM
    && instruction.data?.[0] === 1
    && typeof instruction.accounts?.[1]?.address === 'string'
}

// Rebase the installed SDK flash-repay instruction index after composition (setup deduplicated first).
export function composeAtomicOpenInstructions(acquisitionInstructions, sdkOpenInstructions, existingTokenAccounts = new Set()) {
  if (!Array.isArray(acquisitionInstructions) || !Array.isArray(sdkOpenInstructions) || !(existingTokenAccounts instanceof Set)) {
    throw new TypeError('Atomic open instructions must be arrays and existing token accounts must be a Set.')
  }
  const sdkFlash = flashInstructionIndexes(sdkOpenInstructions)
  if (sdkFlash.borrowIndexes.length || sdkFlash.repayIndexes.length) {
    if (sdkFlash.borrowIndexes.length !== 1 || sdkFlash.repayIndexes.length !== 1) {
      throw new Error('SDK Multiply open must contain exactly one flash borrow and repay instruction.')
    }
    const originalRepay = sdkOpenInstructions[sdkFlash.repayIndexes[0]]
    if (!(originalRepay.data instanceof Uint8Array) || originalRepay.data.length <= 16
      || originalRepay.data[16] !== sdkFlash.borrowIndexes[0]) {
      throw new Error('SDK flash repay instruction does not point to its borrow instruction before composition.')
    }
  }

  const allInstructions = [...acquisitionInstructions, ...sdkOpenInstructions]
  const computeBudget = []
  const seenComputeBudget = new Set()
  for (const instruction of allInstructions) {
    if (String(instruction?.programAddress) !== COMPUTE_BUDGET_PROGRAM) continue
    const identity = JSON.stringify({ accounts: instruction.accounts ?? [], data: Buffer.from(instruction.data ?? []).toString('hex') })
    if (seenComputeBudget.has(identity)) continue
    seenComputeBudget.add(identity)
    computeBudget.push(instruction)
  }

  const setup = []
  const seenTokenAccounts = new Set([...existingTokenAccounts].map(String))
  for (const instruction of allInstructions) {
    if (!isAssociatedTokenCreate(instruction)) continue
    const tokenAccount = String(instruction.accounts[1].address)
    if (seenTokenAccounts.has(tokenAccount)) continue
    seenTokenAccounts.add(tokenAccount)
    setup.push(instruction)
  }
  const economic = allInstructions.filter((instruction) =>
    String(instruction?.programAddress) !== COMPUTE_BUDGET_PROGRAM && !isAssociatedTokenCreate(instruction))
  const composed = [...computeBudget, ...setup, ...economic]
  const finalFlash = flashInstructionIndexes(composed)
  if (sdkFlash.borrowIndexes.length) {
    if (finalFlash.borrowIndexes.length !== 1 || finalFlash.repayIndexes.length !== 1) {
      throw new Error('Composed Multiply open lost its flash borrow or repay instruction.')
    }
    const borrowInstructionIndex = finalFlash.borrowIndexes[0]
    const repayInstructionIndex = finalFlash.repayIndexes[0]
    if (borrowInstructionIndex >= repayInstructionIndex || borrowInstructionIndex > 255) {
      throw new Error('Composed Multiply open has an invalid flash-loan instruction order.')
    }
    const repay = composed[repayInstructionIndex]
    const data = Uint8Array.from(repay.data)
    data[16] = borrowInstructionIndex
    composed[repayInstructionIndex] = { ...repay, data }
  }
  return composed
}
