import * as Web3 from 'web3'
import * as chai from 'chai'
import * as asPromised from 'chai-as-promised'
import * as contracts from './'
import * as util from 'ethereumjs-util'
import TestToken from './wrappers/TestToken'
import { BigNumber } from 'bignumber.js'
import { Debt } from './'
import * as ethers from 'ethers'
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

const delay = (ms: number) => new Promise(res => setTimeout(res, ms))

contract('Holding', accounts => {
  const ALICE = accounts[0]
  const BOB = accounts[1]
  const DELEGATE_ALICE = accounts[2]
  const DELEGATE_BOB = accounts[3]
  const ALIEN = accounts[5]

  const ETH_AS_TOKEN_ADDRESS = solUtils.nullAddress()

  const ethProvider = new ethers.providers.JsonRpcProvider()

  console.log(`ALICE is ${ALICE}`)
  console.log(`BOB is ${BOB}`)

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

  specify('constructor', async () => {
    const holding = await Holding.new(3, instanceClearingHouse.address, { from: ALICE })
    const isOwner = await holding.isOwner(ALICE)
    assert(isOwner)
  })

  describe('.deposit', () => {
    specify('tokens: usual case', async () => {
      await token.approve(instanceA.address, 1000, { from: ALICE })
      await instanceA.deposit(token.address, 100, { from: ALICE })
      const tokenBalance = await token.balanceOf(instanceA.address)
      assert.equal(tokenBalance.toString(), '100')
      const holdingBalance = await instanceA.balance(token.address)
      assert.equal(holdingBalance.toString(), '100')
    })

    specify('tokens: must fails when user wants to deposit too much', async () => {
      await token.approve(instanceA.address, 1000, { from: ALICE })
      const tokenBalanceBefore = await token.balanceOf(instanceA.address)
      const holdingBalanceBefore = await instanceA.balance(token.address)
      assert.equal(tokenBalanceBefore.toString(), '0')
      assert.equal(holdingBalanceBefore.toString(), '0')
      await assert.isRejected(instanceA.deposit(token.address, 100 * 100, { from: ALICE })) // tslint:disable-line:await-promise
      const tokenBalanceAfter = await token.balanceOf(instanceA.address)
      const holdingBalanceAfter = await instanceA.balance(token.address)
      assert.equal(tokenBalanceAfter.toString(), '0')
      assert.equal(holdingBalanceAfter.toString(), '0')
    })

    specify('eth: usual case', async () => {
      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), '0.0')

      await instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther('0.01').toString()),
        { from: ALICE, to: instanceA.address, value: ethers.utils.parseEther('0.01').toString() })

      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceAfter.toString()).toString(), '0.01')
    })

    specify('eth: must fails when user wants to deposit too much', async () => {
      const aliceBalance = (await ethProvider.getBalance(ALICE)).toString()
      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), '0.0')

      await assert.isRejected(instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther('0.01').toString()),
        { from: ALICE, to: instanceA.address, value: new BigNumber(aliceBalance).add(1).toString() })) // tslint:disable-line:await-promise

      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(holdingBalanceAfter.toString(), holdingBalanceBefore.toString())
    })
  })

  describe('.addDebt', () => {
    const amount = 10
    const settlementPeriod = 0

    specify('add debt', async () => {
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      const tx = await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      assert(contracts.Holding.isDidAddDebtEvent(tx.logs[0]))
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      const rawDebt = await instanceA.debts(debtIdentifierResult)
      const debt = Debt.fromContract(rawDebt)
      assert.equal(debt.amount.toString(), amount.toString())
      assert.notEqual(debt.collectionAfter.toString(), '0')
    })

    specify('pass if sigMine is incorrect', async () => {
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      return assert.isRejected(instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureB, signatureB))
    })

    specify('ok if signed by my delegate key', async () => {
      const addSignerDigest = await instanceA.addSignerDigest(DELEGATE_ALICE)
      const signatureAddSigner = await signature(ALICE, addSignerDigest)
      await instanceA.addSigner(DELEGATE_ALICE, signatureAddSigner)
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(DELEGATE_ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      const tx = await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      assert(contracts.Holding.isDidAddDebtEvent(tx.logs[0]))
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      const rawDebt = await instanceA.debts(debtIdentifierResult)
      const debt = Debt.fromContract(rawDebt)
      assert.equal(debt.amount.toString(), amount.toString())
      assert.notEqual(debt.collectionAfter.toString(), '0')
    })

    specify('ok if signed by others delegate key', async () => {
      const addSignerDigest = await instanceB.addSignerDigest(DELEGATE_BOB)
      const signatureAddSigner = await signature(BOB, addSignerDigest)
      await instanceB.addSigner(DELEGATE_BOB, signatureAddSigner)
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(DELEGATE_BOB, digest)
      const salt = 0x125
      const tx = await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      assert(contracts.Holding.isDidAddDebtEvent(tx.logs[0]))
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      const rawDebt = await instanceA.debts(debtIdentifierResult)
      const debt = Debt.fromContract(rawDebt)
      assert.equal(debt.amount.toString(), amount.toString())
      assert.notEqual(debt.collectionAfter.toString(), '0')
    })

    specify('pass if sigOther is incorrect', async () => {
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(ALICE, digest)
      const salt = 0x125
      return assert.isRejected(instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureA))
    })

    specify('can not override', async () => {
      const digest1 = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(ALICE, digest1)
      const signatureB = await signature(BOB, digest1)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      const rawDebt = await instanceA.debts(debtIdentifierResult)
      const debt = Debt.fromContract(rawDebt)
      assert.equal(debt.amount.toString(), amount.toString())
      assert.notEqual(debt.collectionAfter.toString(), '0')

      const amount2 = 20
      const digest2 = await instanceA.addDebtDigest(instanceB.address, token.address, amount2, 0)
      const signatureA2 = await signature(ALICE, digest2)
      const signatureB2 = await signature(BOB, digest2)
      return assert.isRejected(instanceA.addDebt(instanceB.address, token.address, amount2, salt, settlementPeriod, signatureA2, signatureB2))
    })
  })

  describe('.collect', () => {
    const amount = 10
    const settlementPeriod = 0

    specify('tokens: usual case', async () => {
      await token.approve(instanceA.address, 1000, {from: ALICE})
      await instanceA.deposit(token.address, 10, {from: ALICE})
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, 0)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      const collectDigest = await instanceA.collectDigest(token.address)
      const collectSignature = await signature(BOB, collectDigest)

      const balanceBefore = await token.balanceOf(instanceB.address)
      const holdingBefore = await instanceB.balance(token.address)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      let tx = await instanceA.collectDebt(debtIdentifierResult, collectSignature)
      assert(contracts.Holding.isDidCloseEvent(tx.logs[0]))
      assert(contracts.Holding.isDidDepositEvent(tx.logs[1]))
      assert(contracts.Holding.isDidOnCollectDebtEvent(tx.logs[2]))
      assert(contracts.Holding.isDidCollectEvent(tx.logs[3]))
      const balanceAfter = await token.balanceOf(instanceB.address)
      assert.equal(balanceAfter.sub(balanceBefore).toString(), amount.toString())

      const holdingAfter = await instanceB.balance(token.address)
      assert.equal(holdingAfter.sub(holdingBefore).toString(), amount.toString())
    })

    specify('eth: usual case', async () => {
      const value = ethers.utils.parseEther('0.01').toString()

      await instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther('0.01').toString()),
        { from: ALICE, to: instanceA.address, value: ethers.utils.parseEther('0.01').toString() })

      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), '0.01')

      const digest = await instanceA.addDebtDigest(instanceB.address, ETH_AS_TOKEN_ADDRESS, new BigNumber(value), 0)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, ETH_AS_TOKEN_ADDRESS, new BigNumber(value), salt, settlementPeriod, signatureA, signatureB)
      const collectDigest = await instanceA.collectDigest(ETH_AS_TOKEN_ADDRESS)
      const collectSignature = await signature(BOB, collectDigest)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, ETH_AS_TOKEN_ADDRESS, salt)
      await instanceA.collectDebt(debtIdentifierResult, collectSignature)
      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(holdingBalanceAfter.sub(holdingBalanceBefore).toString(),
        (new BigNumber(value).mul(-1)).toString(),
        'Subtract of holding balances must be equal to -value')
    })
  })

  describe('.withdraw', () => {
    specify('tokens: usual case', async () => {
      await token.approve(instanceA.address, 1000, {from: ALICE})
      await instanceA.deposit(token.address, 100, {from: ALICE})
      const tokenBalance = await token.balanceOf(instanceA.address)
      assert.equal(tokenBalance.toString(), '100')
      const holdingBalance = await instanceA.balance(token.address)
      assert.equal(holdingBalance.toString(), '100')

      const withdrawal = 10
      const digest = await instanceA.withdrawDigest(BOB, token.address, withdrawal)
      const signatureA = await signature(ALICE, digest)
      const balanceBefore = await token.balanceOf(BOB)
      await instanceA.withdraw(BOB, token.address, withdrawal, signatureA)
      const balanceAfter = await token.balanceOf(BOB)
      assert.equal(balanceAfter.sub(balanceBefore).toString(), withdrawal.toString())
      const holdingBalanceAfter = await instanceA.balance(token.address)
      assert.equal(holdingBalanceAfter.sub(holdingBalance).toString(), (-1 * withdrawal).toString())
    })

    specify('tokens: must fails when user wants to withdraw too much', async () => {
      await token.approve(instanceA.address, 1000, {from: ALICE})
      await instanceA.deposit(token.address, 100, {from: ALICE})
      const tokenBalance = await token.balanceOf(instanceA.address)
      assert.equal(tokenBalance.toString(), '100')
      const holdingBalance = await instanceA.balance(token.address)
      assert.equal(holdingBalance.toString(), '100')

      const withdrawal = 100000000
      const digest = await instanceA.withdrawDigest(BOB, token.address, withdrawal)
      const signatureA = await signature(ALICE, digest)
      const balanceBefore = await token.balanceOf(BOB)
      await assert.isRejected(instanceA.withdraw(BOB, token.address, withdrawal, signatureA)) // tslint:disable-line:await-promise
      const balanceAfter = await token.balanceOf(BOB)
      assert.equal(balanceAfter.toString(), balanceBefore.toString())
      const holdingBalanceAfter = await instanceA.balance(token.address)
      assert.equal(holdingBalanceAfter.toString(), holdingBalance.toString())
    })

    specify('tokens: must fails when signature is wrong', async () => {
      await token.approve(instanceA.address, 1000, {from: ALICE})
      await instanceA.deposit(token.address, 100, {from: ALICE})
      const tokenBalance = await token.balanceOf(instanceA.address)
      assert.equal(tokenBalance.toString(), '100')
      const holdingBalance = await instanceA.balance(token.address)
      assert.equal(holdingBalance.toString(), '100')

      const withdrawal = 10
      const digest = await instanceA.withdrawDigest(BOB, token.address, withdrawal)
      const signatureA = await signature(DELEGATE_ALICE, digest)
      const balanceBefore = await token.balanceOf(BOB)
      await assert.isRejected(instanceA.withdraw(BOB, token.address, withdrawal, signatureA)) // tslint:disable-line:await-promise
      const balanceAfter = await token.balanceOf(BOB)
      assert.equal(balanceAfter.toString(), balanceBefore.toString())
      const holdingBalanceAfter = await instanceA.balance(token.address)
      assert.equal(holdingBalanceAfter.toString(), holdingBalance.toString())
    })

    specify('eth: usual case', async () => {
      await instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther('0.01').toString()),
        { from: ALICE, to: instanceA.address, value: ethers.utils.parseEther('0.01').toString() })

      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), '0.01')

      const withdrawal = new BigNumber(ethers.utils.parseEther('0.01').toString())
      const digest = await instanceA.withdrawDigest(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal)
      const signatureA = await signature(ALICE, digest)
      const balanceBefore = await ethProvider.getBalance(BOB)
      await instanceA.withdraw(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal, signatureA)
      const balanceAfter = await ethProvider.getBalance(BOB)
      assert.equal(balanceAfter.sub(balanceBefore).toString(),
        withdrawal.toString(),
        'Subtract of balances must be equal to withdrawal')
      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(holdingBalanceAfter.sub(holdingBalanceBefore).toString(),
        (new BigNumber(withdrawal).mul(-1)).toString(),
        'Subtract of holding balances must be equal to -withdrawal')
    })

    specify('eth: must fails when user wants to withdraw too much', async () => {
      const depositValue = '0.01'
      await instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther(depositValue).toString()),
        { from: ALICE, to: instanceA.address, value: ethers.utils.parseEther(depositValue).toString() })

      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), depositValue)

      const withdrawal = new BigNumber(ethers.utils.parseEther(new BigNumber(depositValue).plus(1).toString()).toString())
      const digest = await instanceA.withdrawDigest(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal)
      const signatureA = await signature(ALICE, digest)
      const balanceBefore = await ethProvider.getBalance(BOB)
      await assert.isRejected(instanceA.withdraw(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal, signatureA)) // tslint:disable-line:await-promise
      const balanceAfter = await ethProvider.getBalance(BOB)
      assert.equal(balanceAfter.toString(),
        balanceBefore.toString(),
        'Balances before and after must be equal')
      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(holdingBalanceAfter.toString(),
        holdingBalanceBefore.toString(),
        'Holding balances before and after must be equal')
    })

    specify('eth: must fails when signature is wrong', async () => {
      await instanceA.deposit(ETH_AS_TOKEN_ADDRESS,
        new BigNumber(ethers.utils.parseEther('0.01').toString()),
        { from: ALICE, to: instanceA.address, value: ethers.utils.parseEther('0.01').toString() })

      const holdingBalanceBefore = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(ethers.utils.formatEther(holdingBalanceBefore.toString()).toString(), '0.01')

      const withdrawal = new BigNumber(ethers.utils.parseEther('0.01').toString())
      const digest = await instanceA.withdrawDigest(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal)
      const signatureA = await signature(DELEGATE_ALICE, digest)
      const balanceBefore = await ethProvider.getBalance(BOB)
      await assert.isRejected(instanceA.withdraw(BOB, ETH_AS_TOKEN_ADDRESS, withdrawal, signatureA)) // tslint:disable-line:await-promise
      const balanceAfter = await ethProvider.getBalance(BOB)
      assert.equal(balanceAfter.toString(),
        balanceBefore.toString(),
        'Balances before and after must be equal')
      const holdingBalanceAfter = await instanceA.balance(ETH_AS_TOKEN_ADDRESS)
      assert.equal(holdingBalanceAfter.toString(),
        holdingBalanceBefore.toString(),
        'Holding balances before and after must be equal')
    })
  })

  specify('forgive', async () => {
    const amount = 100
    await token.approve(instanceA.address, 1000, {from: ALICE})
    await instanceA.deposit(token.address, amount, {from: ALICE})

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
  })

  describe('.retire', () => {
    specify('usual case', async () => {
      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureARetire = await signature(ALICE, retireDigest)
      const currentState = await instanceA.currentState.call()
      assert.equal(currentState.toString(), '0')
      await instanceA.retire(signatureARetire)
      const currentState2 = await instanceA.currentState.call()
      assert.equal(currentState2.toString(), '1')
    })

    specify('not in Active state', async () => {
      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureARetire = await signature(ALICE, retireDigest)
      await instanceA.retire(signatureARetire)
      return assert.isRejected(instanceA.retire(signatureARetire))
    })

    specify('must fails when owner\' signature is wrong', async () => {
      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureDARetire = await signature(DELEGATE_ALICE, retireDigest)
      return assert.isRejected(instanceA.retire(signatureDARetire))
    })
  })

  specify('currentState', async () => {
    const retireDigest = await instanceA.retireDigest(instanceA.address)
    const signatureARetire = await signature(ALICE, retireDigest)
    const currentState = await instanceA.currentState.call()
    assert.equal(currentState.toString(), '0')
    await instanceA.retire(signatureARetire)
    const currentState2 = await instanceA.currentState.call()
    assert.equal(currentState2.toString(), '1')
  })

  describe('.stop', () => {
    specify('usual case', async () => {
      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureARetire = await signature(ALICE, retireDigest)
      const currentState = await instanceA.currentState.call()
      assert.equal(currentState.toString(), '0')
      await instanceA.retire(signatureARetire)

      await delay(4000)
      await instanceA.stop()
      await assert.isRejected(instanceA.currentState.call()) // tslint:disable-line:await-promise
    })

    specify('must fails because of non-empty debts', async () => {
      await token.approve(instanceA.address, 100, { from: ALICE })
      await instanceA.deposit(token.address, 100, { from: ALICE })
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, 100, 0)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, 100, salt, 0, signatureA, signatureB)

      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureARetire = await signature(ALICE, retireDigest)
      const currentState = await instanceA.currentState.call()
      assert.equal(currentState.toString(), '0')
      await instanceA.retire(signatureARetire)

      await delay(4000)
      await assert.isRejected(instanceA.stop()) // tslint:disable-line:await-promise
    })

    specify('must fails because of non-empty balances', async () => {
      await token.approve(instanceA.address, 100, { from: ALICE })
      await instanceA.deposit(token.address, 100, { from: ALICE })
      const retireDigest = await instanceA.retireDigest(instanceA.address)
      const signatureARetire = await signature(ALICE, retireDigest)
      const currentState = await instanceA.currentState.call()
      assert.equal(currentState.toString(), '0')
      await instanceA.retire(signatureARetire)

      await delay(4000)
      await assert.isRejected(instanceA.stop()) // tslint:disable-line:await-promise
    })
  })

  describe('.ownable', () => {
    describe('.isOwner', () => {
      specify('yes, it is owner', async () => {
        const isOwner = await instanceA.isOwner(ALICE)
        assert(isOwner)
      })

      specify('not an owner', async () => {
        const isOwner = await instanceA.isOwner(BOB)
        assert(!isOwner)
      })
    })

    describe('.addOwner', () => {
      specify('usual case', async () => {
        const isOwnerBefore = await instanceA.isOwner(ALIEN)
        assert(!isOwnerBefore)
        const addOwnerDigest = await instanceA.addOwnerDigest(ALIEN)
        const signatureAddOwner = await signature(ALICE, addOwnerDigest)
        await instanceA.addOwner(ALIEN, signatureAddOwner)
        const isOwnerAfter = await instanceA.isOwner(ALIEN)
        assert(isOwnerAfter)
      })

      specify('must fails when signature of new owner is wrong', async () => {
        const isOwnerBefore = await instanceA.isOwner(ALIEN)
        assert(!isOwnerBefore)
        const addOwnerDigest = await instanceA.addOwnerDigest(ALIEN)
        const signatureAddOwner = await signature(BOB, addOwnerDigest)
        await assert.isRejected(instanceA.addOwner(ALIEN, signatureAddOwner)) // tslint:disable-line:await-promise
        const isOwnerAfter = await instanceA.isOwner(ALIEN)
        assert(!isOwnerAfter)
      })
    })

    describe('.removeOwner', () => {
      specify('usual case', async () => {
        const isOwnerBefore = await instanceA.isOwner(ALIEN)
        assert(!isOwnerBefore)
        const addOwnerDigest = await instanceA.addOwnerDigest(ALIEN)
        const signatureAddOwner = await signature(ALICE, addOwnerDigest)
        await instanceA.addOwner(ALIEN, signatureAddOwner)
        const isOwnerAfter = await instanceA.isOwner(ALIEN)
        assert(isOwnerAfter)
        const removeOwnerDigest = await instanceA.removeOwnerDigest(ALIEN)
        const signatureRemoveOwner = await signature(ALIEN, removeOwnerDigest)
        await instanceA.removeOwner(ALIEN, signatureRemoveOwner)
        const isOwnerAfterRemoving = await instanceA.isOwner(ALIEN)
        assert(!isOwnerAfterRemoving)
      })

      specify('must fails when signature of owner is wrong', async () => {
        const isOwnerBefore = await instanceA.isOwner(ALIEN)
        assert(!isOwnerBefore)
        const addOwnerDigest = await instanceA.addOwnerDigest(ALIEN)
        const signatureAddOwner = await signature(ALICE, addOwnerDigest)
        await instanceA.addOwner(ALIEN, signatureAddOwner)
        const isOwnerAfter = await instanceA.isOwner(ALIEN)
        assert(isOwnerAfter)
        const removeOwnerDigest = await instanceA.removeOwnerDigest(ALIEN)
        const signatureRemoveOwner = await signature(BOB, removeOwnerDigest)
        await assert.isRejected(instanceA.removeOwner(ALIEN, signatureRemoveOwner)) // tslint:disable-line:await-promise
        const isOwnerAfterRemoving = await instanceA.isOwner(ALIEN)
        assert(isOwnerAfterRemoving)
      })
    })
  })

  describe('.signers', () => {
    describe('.isSigner', () => {
      specify('yes, it is signer', async () => {
        const isOwner = await instanceA.isSigner(ALICE)
        assert(isOwner)
      })

      specify('not an signer', async () => {
        const isOwner = await instanceA.isOwner(BOB)
        assert(!isOwner)
      })
    })

    describe('.addSigner', () => {
      specify('usual case', async () => {
        const isSignerBefore = await instanceA.isSigner(ALIEN)
        assert(!isSignerBefore)
        const addSignerDigest = await instanceA.addSignerDigest(ALIEN)
        const signatureAddSigner = await signature(ALICE, addSignerDigest)
        await instanceA.addSigner(ALIEN, signatureAddSigner)
        const isSignerAfter = await instanceA.isSigner(ALIEN)
        assert(isSignerAfter)
      })

      specify('must fails when signature of new signer is wrong', async () => {
        const isSignerBefore = await instanceA.isSigner(ALIEN)
        assert(!isSignerBefore)
        const addSignerDigest = await instanceA.addSignerDigest(ALIEN)
        const signatureAddSigner = await signature(BOB, addSignerDigest)
        await assert.isRejected(instanceA.addSigner(ALIEN, signatureAddSigner)) // tslint:disable-line:await-promise
        const isSignerAfter = await instanceA.isSigner(ALIEN)
        assert(!isSignerAfter)
      })
    })

    describe('.removeSigner', () => {
      specify('usual case', async () => {
        const isSignerBefore = await instanceA.isSigner(ALIEN)
        assert(!isSignerBefore)
        const addSignerDigest = await instanceA.addSignerDigest(ALIEN)
        const signatureAddSigner = await signature(ALICE, addSignerDigest)
        await instanceA.addSigner(ALIEN, signatureAddSigner)
        const isSignerAfter = await instanceA.isSigner(ALIEN)
        assert(isSignerAfter)
        const removeSignerDigest = await instanceA.removeSignerDigest(ALIEN)
        const signatureRemoveSigner = await signature(ALICE, removeSignerDigest)
        await instanceA.removeSigner(ALIEN, signatureRemoveSigner)
        const isSignerAfterRemoving = await instanceA.isSigner(ALIEN)
        assert(!isSignerAfterRemoving)
      })

      specify('must fails when signature of signer is wrong', async () => {
        const isSingerBefore = await instanceA.isSigner(ALIEN)
        assert(!isSingerBefore)
        const addSignerDigest = await instanceA.addSignerDigest(ALIEN)
        const signatureAddSigner = await signature(ALICE, addSignerDigest)
        await instanceA.addSigner(ALIEN, signatureAddSigner)
        const isSignerAfter = await instanceA.isSigner(ALIEN)
        assert(isSignerAfter)
        const removeSignerDigest = await instanceA.removeSignerDigest(ALIEN)
        const signatureRemoveSigner = await signature(BOB, removeSignerDigest)
        await assert.isRejected(instanceA.removeSigner(ALIEN, signatureRemoveSigner)) // tslint:disable-line:await-promise
        const isSignerAfterRemoving = await instanceA.isSigner(ALIEN)
        assert(isSignerAfterRemoving)
      })
    })
  })

  describe('.removeDebt', () => {
    const amount = 1000
    const settlementPeriod = 0

    specify('usual case', async () => {
      await token.approve(instanceA.address, amount, {from: ALICE})
      await instanceA.deposit(token.address, amount, {from: ALICE})
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount, settlementPeriod)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, amount, salt, settlementPeriod, signatureA, signatureB)
      const collectDigest = await instanceA.collectDigest(token.address)
      const collectSignature = await signature(BOB, collectDigest)

      const balanceBefore = await token.balanceOf(instanceB.address)
      const holdingBefore = await instanceB.balance(token.address)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      let tx = await instanceA.collectDebt(debtIdentifierResult, collectSignature)
      assert(contracts.Holding.isDidCloseEvent(tx.logs[0]))
      assert(contracts.Holding.isDidDepositEvent(tx.logs[1]))
      assert(contracts.Holding.isDidOnCollectDebtEvent(tx.logs[2]))
      assert(contracts.Holding.isDidCollectEvent(tx.logs[3]))
      const balanceAfter = await token.balanceOf(instanceB.address)

      assert.equal(balanceAfter.sub(balanceBefore).toString(), amount.toString())
      const holdingAfter = await instanceB.balance(token.address)
      assert.equal(holdingAfter.sub(holdingBefore).toString(), amount.toString())

      const tx2 = await instanceA.removeDebt(debtIdentifierResult)
      assert(contracts.Holding.isDidRemoveDebtEvent(tx2.logs[0]))
    })

    specify('must fails when debt id does not exists', async () => {
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

      await assert.isRejected(instanceA.removeDebt(debtIdentifierResult)) // tslint:disable-line:await-promise
    })

    specify('must fails if debt is not cleared or fully repaid', async () => {
      await token.approve(instanceA.address, amount, {from: ALICE})
      await instanceA.deposit(token.address, amount, {from: ALICE})
      const digest = await instanceA.addDebtDigest(instanceB.address, token.address, amount + 1, settlementPeriod)
      const signatureA = await signature(ALICE, digest)
      const signatureB = await signature(BOB, digest)
      const salt = 0x125
      await instanceA.addDebt(instanceB.address, token.address, amount + 1, salt, settlementPeriod, signatureA, signatureB)
      const collectDigest = await instanceA.collectDigest(token.address)
      const collectSignature = await signature(BOB, collectDigest)

      const balanceBefore = await token.balanceOf(instanceB.address)
      const holdingBefore = await instanceB.balance(token.address)
      const debtIdentifierResult = await instanceA.debtIdentifier.call(instanceB.address, token.address, salt)
      let tx = await instanceA.collectDebt(debtIdentifierResult, collectSignature)
      assert(contracts.Holding.isDidDepositEvent(tx.logs[0]))
      assert(contracts.Holding.isDidOnCollectDebtEvent(tx.logs[1]))
      assert(contracts.Holding.isDidCollectEvent(tx.logs[2]))
      const balanceAfter = await token.balanceOf(instanceB.address)

      assert.equal(balanceAfter.sub(balanceBefore).toString(), amount.toString())
      const holdingAfter = await instanceB.balance(token.address)
      assert.equal(holdingAfter.sub(holdingBefore).toString(), amount.toString())

      await assert.isRejected(instanceA.removeDebt(debtIdentifierResult)) // tslint:disable-line:await-promise
    })
  })
})
