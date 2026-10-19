import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.TESTNET_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

  const tx = {
    transaction: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    contractAbiSubmission: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    contractAbiSubmissionEvent: { create: vi.fn() },
    contractNetwork: { findUnique: vi.fn(), upsert: vi.fn() },
    contract: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    tx,
    readTransactions: vi.fn(),
    readEvents: vi.fn(),
    findSubmission: vi.fn(),
    listSubmissions: vi.fn(),
    countSubmissions: vi.fn(),
    readSubmissionById: vi.fn(),
    contractUpsert: vi.fn(),
    contractNetworkUpsert: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
});

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: { findMany: mocks.readTransactions },
    event: { findMany: mocks.readEvents },
    contract: { findUnique: vi.fn() },
    contractAbiSubmission: {
      findUnique: mocks.readSubmissionById,
    },
  },
  prismaWrite: {
    contract: {
      upsert: mocks.contractUpsert,
    },
    contractNetwork: {
      upsert: mocks.contractNetworkUpsert,
    },
    contractAbiSubmission: {
      findFirst: mocks.findSubmission,
      findMany: mocks.listSubmissions,
      count: mocks.countSubmissions,
      findUnique: mocks.readSubmissionById,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  TRUST_LEVEL_HIERARCHY,
  createContractAbiSubmission,
  publishContractAbiSubmission,
  reviewContractAbiSubmission,
  type ContractMetadataProvenance,
  type TrustLevel,
} from '../../src/services/contract-abi-submissions';
import { registerContractMetadata } from '../../src/api/contracts';

const sampleAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const sampleEvidence = [{ functionName: 'initialize', ledgerSequence: 1200 }];

describe('Contract Metadata Provenance and Trust Level', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSubmission.mockResolvedValue(null);
    mocks.readTransactions.mockResolvedValue(sampleEvidence);
    mocks.readEvents.mockResolvedValue([]);
    mocks.tx.transaction.findMany.mockResolvedValue(sampleEvidence);
    mocks.tx.event.findMany.mockResolvedValue([]);
    mocks.tx.contractAbiSubmission.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.contractAbiSubmissionEvent.create.mockResolvedValue({ id: 'event-1' });
    mocks.tx.contractNetwork.findUnique.mockResolvedValue(null);
    mocks.tx.contractNetwork.upsert.mockResolvedValue({ id: 'deployment-1' });
    mocks.tx.contract.upsert.mockResolvedValue({ id: 'contract-1', address: sampleAddress });
  });

  it('defines the expected trust level hierarchy ranking', () => {
    expect(TRUST_LEVEL_HIERARCHY.unverified).toBeLessThan(TRUST_LEVEL_HIERARCHY.community);
    expect(TRUST_LEVEL_HIERARCHY.community).toBeLessThan(TRUST_LEVEL_HIERARCHY.verified_publisher);
    expect(TRUST_LEVEL_HIERARCHY.verified_publisher).toBeLessThan(TRUST_LEVEL_HIERARCHY.canonical);
    expect(TRUST_LEVEL_HIERARCHY.canonical).toBeLessThan(TRUST_LEVEL_HIERARCHY.official);
  });

  it('defaults trustLevel to unverified when none is provided in submission', async () => {
    mocks.tx.contractAbiSubmission.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'sub-default', ...data }),
    );

    const { submission } = await createContractAbiSubmission(
      {
        address: sampleAddress,
        network: 'testnet',
        abi: { functions: [{ name: 'initialize', inputs: [] }] },
      },
      'developer-123',
    );

    expect(mocks.tx.contractAbiSubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trustLevel: 'unverified',
          provenance: null,
        }),
      }),
    );
    expect(submission.trustLevel).toBe('unverified');
  });

  it('records custom provenance and verified_publisher trust level on submission', async () => {
    const provenance: ContractMetadataProvenance = {
      source: 'github',
      repoUrl: 'https://github.com/example-org/soroban-token',
      commitHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      submitterIdentity: 'example-publisher',
      signature: '0xsignature_attestation_bytes',
      signerAddress: 'GABC1234567890EXAMPLE',
      verifiedAt: '2026-10-19T20:00:00.000Z',
    };

    mocks.tx.contractAbiSubmission.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'sub-verified', ...data }),
    );

    const { submission } = await createContractAbiSubmission(
      {
        address: sampleAddress,
        network: 'testnet',
        trustLevel: 'verified_publisher',
        provenance,
        abi: { functions: [{ name: 'initialize', inputs: [] }] },
      },
      'developer-123',
    );

    expect(mocks.tx.contractAbiSubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trustLevel: 'verified_publisher',
          provenance,
        }),
      }),
    );
    expect(submission.trustLevel).toBe('verified_publisher');
    expect(submission.provenance).toEqual(provenance);
  });

  it('allows maintainer to elevate trust level and update provenance upon approval', async () => {
    mocks.tx.contractAbiSubmission.findUniqueOrThrow.mockResolvedValue({
      id: 'sub-elevate',
      status: 'approved',
      trustLevel: 'official',
      reviewedBy: 'admin-auditor',
    });

    const updatedProvenance: ContractMetadataProvenance = {
      source: 'soroban_registry_audit',
      notes: 'Manually verified against Soroban official core deployment',
    };

    await reviewContractAbiSubmission(
      'sub-elevate',
      'approved',
      'admin-auditor',
      'Approved after security review',
      'official',
      updatedProvenance,
    );

    expect(mocks.tx.contractAbiSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub-elevate', status: 'pending' },
        data: expect.objectContaining({
          status: 'approved',
          reviewedBy: 'admin-auditor',
          trustLevel: 'official',
          provenance: updatedProvenance,
        }),
      }),
    );
  });

  it('propagates trust level and provenance to Contract and ContractNetwork on publication', async () => {
    const provenance: ContractMetadataProvenance = {
      source: 'github',
      repoUrl: 'https://github.com/example/contract',
      commitHash: 'deadbeef1234567890',
    };

    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({
      id: 'sub-pub',
      address: sampleAddress,
      network: 'testnet',
      status: 'approved',
      trustLevel: 'canonical',
      provenance,
      payload: {
        address: sampleAddress,
        network: 'testnet',
        name: 'Canonical Contract',
        abi: { functions: [{ name: 'initialize', inputs: [] }] },
      },
    });

    mocks.tx.contractAbiSubmission.findUniqueOrThrow.mockResolvedValue({
      id: 'sub-pub',
      status: 'published',
      trustLevel: 'canonical',
      provenance,
    });

    await publishContractAbiSubmission('sub-pub', 'publisher-bot');

    expect(mocks.tx.contract.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address: sampleAddress },
        create: expect.objectContaining({
          trustLevel: 'canonical',
          provenance,
        }),
        update: expect.objectContaining({
          trustLevel: 'canonical',
          provenance,
        }),
      }),
    );

    expect(mocks.tx.contractNetwork.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address_network: { address: sampleAddress, network: 'testnet' } },
        create: expect.objectContaining({
          trustLevel: 'canonical',
          provenance,
        }),
        update: expect.objectContaining({
          trustLevel: 'canonical',
          provenance,
        }),
      }),
    );
  });

  it('persists trustLevel and provenance directly via registerContractMetadata', async () => {
    const provenance = {
      source: 'cli',
      deployer: 'GABC1234',
    };

    mocks.contractUpsert.mockResolvedValue({ id: 'c-direct', address: sampleAddress });
    mocks.contractNetworkUpsert.mockResolvedValue({ id: 'cn-direct', address: sampleAddress, network: 'testnet' });

    await registerContractMetadata({
      address: sampleAddress,
      network: 'testnet',
      name: 'Direct Register',
      trustLevel: 'community',
      provenance,
      abi: {},
    });

    expect(mocks.contractUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          trustLevel: 'community',
          provenance,
        }),
        update: expect.objectContaining({
          trustLevel: 'community',
          provenance,
        }),
      }),
    );

    expect(mocks.contractNetworkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          trustLevel: 'community',
          provenance,
        }),
        update: expect.objectContaining({
          trustLevel: 'community',
          provenance,
        }),
      }),
    );
  });
});
