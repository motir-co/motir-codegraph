import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FETCH_BYTE_CAP_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_TAR_BYTE_CAP_BYTES,
  readFetchSettings,
  readWorkerSettings,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_HARD_CEILING,
  DEFAULT_PER_FILE_CAP_BYTES,
  DEFAULT_STAGED_LAYER_STALENESS_MS,
  perFileCapBytes,
  readLayerSettings,
  requireEnv,
} from '../src/config.js';

describe('requireEnv', () => {
  it('returns the value of a set variable', () => {
    expect(requireEnv('SOME_URL', { SOME_URL: 'postgresql://localhost/x' })).toBe(
      'postgresql://localhost/x',
    );
  });

  it('names the variable when it is unset', () => {
    expect(() => requireEnv('SOME_URL', {})).toThrow(/SOME_URL is not set/);
  });

  it('treats a blank value as unset', () => {
    expect(() => requireEnv('SOME_URL', { SOME_URL: '  ' })).toThrow(/SOME_URL is not set/);
  });
});

describe('perFileCapBytes', () => {
  it('returns the value of PER_FILE_CAP_BYTES when it is set', () => {
    expect(perFileCapBytes({ PER_FILE_CAP_BYTES: '2097152' })).toBe(2_097_152);
  });

  it('defaults to 1,048,576 when it is unset or blank', () => {
    expect(DEFAULT_PER_FILE_CAP_BYTES).toBe(1_048_576);
    expect(perFileCapBytes({})).toBe(1_048_576);
    expect(perFileCapBytes({ PER_FILE_CAP_BYTES: '   ' })).toBe(1_048_576);
  });

  it.each(['abc', '0', '-5', '1.5', '1e6', '0x10', '99999999999999999999'])(
    'throws naming the variable for %s',
    (value) => {
      expect(() => perFileCapBytes({ PER_FILE_CAP_BYTES: value })).toThrow(/PER_FILE_CAP_BYTES/);
    },
  );

  it('reads the process environment by default', () => {
    const before = process.env.PER_FILE_CAP_BYTES;
    process.env.PER_FILE_CAP_BYTES = '4096';
    try {
      expect(perFileCapBytes()).toBe(4_096);
    } finally {
      if (before === undefined) delete process.env.PER_FILE_CAP_BYTES;
      else process.env.PER_FILE_CAP_BYTES = before;
    }
  });
});

describe('readLayerSettings', () => {
  it('defaults all three when the environment names none', () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(8);
    expect(DEFAULT_HARD_CEILING).toBe(32);
    expect(DEFAULT_STAGED_LAYER_STALENESS_MS).toBe(7_200_000);
    expect(readLayerSettings({})).toEqual({
      compactionThreshold: 8,
      hardCeiling: 32,
      stagedLayerStaleness: 7_200_000,
    });
  });

  it('parses each variable set alone, leaving the other two at their defaults', () => {
    expect(readLayerSettings({ COMPACTION_THRESHOLD: '4' })).toEqual({
      compactionThreshold: 4,
      hardCeiling: 32,
      stagedLayerStaleness: 7_200_000,
    });
    expect(readLayerSettings({ HARD_CEILING: '64' })).toEqual({
      compactionThreshold: 8,
      hardCeiling: 64,
      stagedLayerStaleness: 7_200_000,
    });
    expect(readLayerSettings({ STAGED_LAYER_STALENESS_MS: '600000' })).toEqual({
      compactionThreshold: 8,
      hardCeiling: 32,
      stagedLayerStaleness: 600_000,
    });
  });

  it('treats a blank value as unset', () => {
    expect(
      readLayerSettings({
        COMPACTION_THRESHOLD: '',
        HARD_CEILING: '   ',
        STAGED_LAYER_STALENESS_MS: '\t',
      }),
    ).toEqual(readLayerSettings({}));
  });

  const names = ['COMPACTION_THRESHOLD', 'HARD_CEILING', 'STAGED_LAYER_STALENESS_MS'];
  const bad = ['0', '-1', '8.5', 'abc', '1e3', '0x10', '99999999999999999999'];
  it.each(names.flatMap((name) => bad.map((value) => [name, value] as const)))(
    'refuses %s=%s naming the variable and the value',
    (name, value) => {
      expect(() => readLayerSettings({ [name]: value })).toThrow(
        `${name} must be a whole number of 1 or more, not ${value}.`,
      );
    },
  );

  it('refuses a threshold at or above the effective ceiling minus one, naming both', () => {
    for (const threshold of ['31', '32']) {
      expect(() => readLayerSettings({ COMPACTION_THRESHOLD: threshold })).toThrow(
        `COMPACTION_THRESHOLD (${threshold}) must be below HARD_CEILING (32) minus one`,
      );
    }
    expect(readLayerSettings({ COMPACTION_THRESHOLD: '30' }).compactionThreshold).toBe(30);
    expect(() => readLayerSettings({ COMPACTION_THRESHOLD: '10', HARD_CEILING: '10' })).toThrow(
      'COMPACTION_THRESHOLD (10) must be below HARD_CEILING (10) minus one',
    );
  });

  it('checks the pair over effective values when only one of them is set', () => {
    expect(() => readLayerSettings({ COMPACTION_THRESHOLD: '40' })).toThrow(
      'COMPACTION_THRESHOLD (40) must be below HARD_CEILING (32) minus one',
    );
    expect(() => readLayerSettings({ HARD_CEILING: '4' })).toThrow(
      'COMPACTION_THRESHOLD (8) must be below HARD_CEILING (4) minus one',
    );
    expect(readLayerSettings({ HARD_CEILING: '10' })).toEqual({
      compactionThreshold: 8,
      hardCeiling: 10,
      stagedLayerStaleness: 7_200_000,
    });
  });

  it('reads the process environment by default, and nothing at import', () => {
    const before = process.env.HARD_CEILING;
    process.env.HARD_CEILING = '48';
    try {
      expect(readLayerSettings().hardCeiling).toBe(48);
    } finally {
      if (before === undefined) delete process.env.HARD_CEILING;
      else process.env.HARD_CEILING = before;
    }
  });
});

describe('readFetchSettings', () => {
  it('defaults the three numbers when unset or blank, and allows no host', () => {
    for (const env of [
      {},
      { FETCH_BYTE_CAP_BYTES: '', TAR_BYTE_CAP_BYTES: ' ', FETCH_TIMEOUT_MS: '' },
    ]) {
      expect(readFetchSettings(env)).toEqual({
        byteCapBytes: DEFAULT_FETCH_BYTE_CAP_BYTES,
        tarByteCapBytes: DEFAULT_TAR_BYTE_CAP_BYTES,
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        allowedHosts: [],
      });
    }
    // Above a motir-core-sized archive; the timeout well below the 10-minute target.
    expect(DEFAULT_FETCH_BYTE_CAP_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_TAR_BYTE_CAP_BYTES).toBe(1024 * 1024 * 1024);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it('reads each number, and refuses one that is not a positive whole number, naming it', () => {
    expect(
      readFetchSettings({
        FETCH_BYTE_CAP_BYTES: '1000',
        TAR_BYTE_CAP_BYTES: '2000',
        FETCH_TIMEOUT_MS: '3000',
      }),
    ).toMatchObject({ byteCapBytes: 1000, tarByteCapBytes: 2000, timeoutMs: 3000 });
    for (const name of ['FETCH_BYTE_CAP_BYTES', 'TAR_BYTE_CAP_BYTES', 'FETCH_TIMEOUT_MS']) {
      for (const bad of ['0', '-1', '1.5', 'lots']) {
        expect(() => readFetchSettings({ [name]: bad })).toThrow(name);
      }
    }
  });

  it('reads the allowed hosts as bare, lower-cased names, dropping empty entries', () => {
    expect(
      readFetchSettings({ FETCH_ALLOWED_HOSTS: ' Git.Internal ,, source-host,localhost,' })
        .allowedHosts,
    ).toEqual(['git.internal', 'source-host', 'localhost']);
  });

  it('refuses an allowed host carrying a scheme, a port, a path or a wildcard, naming the variable and the entry', () => {
    for (const bad of [
      'https://git.internal',
      'git.internal:8443',
      'git.internal/repo',
      '*.internal',
    ]) {
      expect(() => readFetchSettings({ FETCH_ALLOWED_HOSTS: `ok.host, ${bad}` })).toThrow(
        new RegExp(`FETCH_ALLOWED_HOSTS.*${bad.replace(/[.*/:]/g, '\\$&')}`),
      );
    }
  });
});

describe('readWorkerSettings', () => {
  it('defaults every numeric setting and requires SCRATCH_DIR', () => {
    expect(readWorkerSettings({ SCRATCH_DIR: '/scratch' })).toEqual({
      pollMs: 1_000,
      jobLeaseMs: 300_000,
      maxAttempts: 3,
      scratchDir: '/scratch',
      blobStoreBatchSize: 500,
    });
    expect(
      readWorkerSettings({
        SCRATCH_DIR: '/s',
        WORKER_POLL_MS: '250',
        JOB_LEASE_MS: '60000',
        MAX_ATTEMPTS: '5',
        BLOB_STORE_BATCH_SIZE: '20',
      }),
    ).toEqual({
      pollMs: 250,
      jobLeaseMs: 60_000,
      maxAttempts: 5,
      scratchDir: '/s',
      blobStoreBatchSize: 20,
    });
  });

  it('refuses a malformed number naming its variable, and a missing or blank SCRATCH_DIR', () => {
    for (const name of [
      'WORKER_POLL_MS',
      'JOB_LEASE_MS',
      'MAX_ATTEMPTS',
      'BLOB_STORE_BATCH_SIZE',
    ]) {
      for (const value of ['0', '-1', '1.5', 'soon']) {
        expect(() => readWorkerSettings({ SCRATCH_DIR: '/s', [name]: value })).toThrow(name);
      }
    }
    expect(() => readWorkerSettings({})).toThrow('SCRATCH_DIR');
    expect(() => readWorkerSettings({ SCRATCH_DIR: '  ' })).toThrow('SCRATCH_DIR');
  });
});
