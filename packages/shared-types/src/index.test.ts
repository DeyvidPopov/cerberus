import { describe, expect, it } from 'vitest';

import {
  CredentialSchema,
  CredentialSummaryListSchema,
  CredentialSummarySchema,
} from './index';

describe('CredentialSchema', () => {
  const valid = {
    id: 'abc',
    name: 'GitHub',
    username: 'octocat',
    password: 's3cr3t',
    url: 'https://github.com',
    notes: '',
    itemType: 'login',
    favourite: false,
    category: 'Work tools',
    otpSecret: '',
    passwordUpdatedAt: '2024-01-01T00:00:00Z',
    cardNumber: '',
    cardExpiry: '',
    cardCvv: '',
    cardHolder: '',
  };

  it('accepts a well-formed credential', () => {
    expect(CredentialSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a missing field', () => {
    const { password: _password, ...incomplete } = valid;
    expect(() => CredentialSchema.parse(incomplete)).toThrow();
  });

  it('rejects a field of the wrong type', () => {
    expect(() => CredentialSchema.parse({ ...valid, id: 123 })).toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => CredentialSchema.parse('nope')).toThrow();
  });
});

describe('CredentialSummaryListSchema', () => {
  it('accepts an array of summaries', () => {
    const list = [
      { id: '1', name: 'n', username: 'u', url: '', itemType: 'login', favourite: false, category: '', hasOtp: false },
    ];
    expect(CredentialSummaryListSchema.parse(list)).toEqual(list);
  });

  it('rejects an entry leaking an unexpected non-string field', () => {
    expect(() => CredentialSummarySchema.parse({ id: '1', name: 'n', username: 5 })).toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => CredentialSummaryListSchema.parse({})).toThrow();
  });
});
