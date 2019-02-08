import * as Web3 from 'web3'
import * as chai from 'chai'
import * as asPromised from 'chai-as-promised'
import * as contracts from './'
import * as util from 'ethereumjs-util'
import TestToken from './wrappers/TestToken'
import { Debt } from './'
import * as solUtils from './SolidityUtils'

chai.use(asPromised)

const web3 = (global as any).web3 as Web3
const assert = chai.assert

const ClearingHouse = artifacts.require<contracts.ClearingHouse.Contract>('ClearingHouse.sol')
const Holding = artifacts.require<contracts.Holding.Contract>('Holding.sol')
const Token = artifacts.require<TestToken.Contract>('support/TestToken.sol')

async function signature (signer: string, digestHex: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const checksummed = util.toChecksumAddress(signer)
    web3.eth.sign(digestHex, checksummed, (err, signature) => {
      err ? reject(err) : resolve(signature)
    })
  })
}

contract('ClearingHouse', accounts => {
  const ALICE = accounts[0]
  const BOB = accounts[1]
  const DELEGATE_ALICE = accounts[2]
  const DELEGATE_BOB = accounts[3]

  let instanceA: contracts.Holding.Contract
  let instanceB: contracts.Holding.Contract
  let instanceClearingHouse: contracts.ClearingHouse.Contract
  let token: TestToken.Contract

  beforeEach(async () => {
    token = await Token.new()
    await token.mint(ALICE, 1000)
    await token.mint(BOB, 1000)
    instanceClearingHouse = await ClearingHouse.new()
    instanceA = await Holding.new(3, instanceClearingHouse.address, { from: ALICE })
    instanceB = await Holding.new(3, instanceClearingHouse.address, { from: BOB })
  })

  describe('.clear', () => {
    specify('usual case', async () => {
      const idA = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('0'))
      const idB = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('1'))
      const digest = await instanceClearingHouse.clearDigest(instanceA.address, instanceB.address, idA, idB)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      await instanceClearingHouse.clear(instanceA.address, instanceB.address, idA, idB, signatureA, signatureB)
      const isCleared = await instanceClearingHouse.isCleared(instanceA.address, idA)

      assert.equal(isCleared, true)
    })

    specify('must fails when userA is not a signer of Holding', async () => {
      const idA = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('0'))
      const idB = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('1'))
      const digest = await instanceClearingHouse.clearDigest(instanceA.address, instanceB.address, idA, idB)
      const signatureA = await signature(DELEGATE_ALICE, digest)
      const signatureB = await signature(BOB, digest)
      await assert.isRejected(instanceClearingHouse.clear(instanceA.address, instanceB.address, idA, idB, signatureA, signatureB)) // tslint:disable-line:await-promise
      const isCleared = await instanceClearingHouse.isCleared(instanceA.address, idA)

      assert.equal(isCleared, false)
    })

    specify('must fails when userB is not a signer of Holding', async () => {
      const idA = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('0'))
      const idB = solUtils.bytes32To0xString(solUtils.keccak256FromStrings('1'))
      const digest = await instanceClearingHouse.clearDigest(instanceA.address, instanceB.address, idA, idB)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(DELEGATE_BOB, digest)
      await assert.isRejected(instanceClearingHouse.clear(instanceA.address, instanceB.address, idA, idB, signatureA, signatureB)) // tslint:disable-line:await-promise
      const isCleared = await instanceClearingHouse.isCleared(instanceA.address, idA)

      assert.equal(isCleared, false)
    })
  })

  describe('.forgive', () => {
    specify('usual case', async () => {
      const amount = 100
      await token.approve(instanceA.address, 1000, { from: ALICE })
      await instanceA.deposit(token.address, amount, { from: ALICE })

      const digestAddDebt = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureAAddDebt = await signature(ALICE, digestAddDebt)
      const signatureBAddDebt = await signature(BOB, digestAddDebt)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, amount, salt, 0, signatureAAddDebt, signatureBAddDebt)

      const tokenBalance = await token.balanceOf(instanceA.address)
      assert.equal(tokenBalance.toString(), '100')
      const holdingBalance = await instanceA.balance(token.address)
      assert.equal(holdingBalance.toString(), '100')

      const digest = await instanceA.forgiveDigest(instanceB.address, token.address)
      const signatureB = await signature(BOB, digest)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      await instanceA.forgiveDebt(debtIdentifierResult, signatureB)
      const rawDebt = await instanceA.debts(debtIdentifierResult)
      const debt = Debt.fromContract(rawDebt)
      assert.equal(debt.amount.toString(), '0')
      assert.equal(debt.collectionAfter.toString(), '0')

      const isCleared = await instanceClearingHouse.isCleared(instanceA.address, debtIdentifierResult)

      assert.equal(isCleared, true)
    })
  })
})
