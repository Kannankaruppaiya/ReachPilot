import { Test, TestingModule } from '@nestjs/testing';
import { VaultModule } from '@/modules/vault/vault.module';
import { SecretsService } from '@/modules/vault/secrets.service';
import { KeyManagementService } from '@/modules/vault/key-management.service';
import { withWorkspace } from '@/db/rls';

describe('Vault envelope encryption', () => {
  let secretsService: SecretsService;
  let kms: KeyManagementService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [VaultModule],
    }).compile();

    secretsService = moduleFixture.get<SecretsService>(SecretsService);
    kms = moduleFixture.get<KeyManagementService>(KeyManagementService);
  });

  it('should encrypt and decrypt a secret value successfully', async () => {
    const originalText = 'my-super-secret-password-123!';
    const workspaceId = '00000000-0000-0000-0000-000000000010';

    // encrypt() now internally uses withWorkspace when workspaceId is provided
    const secretId = await secretsService.encrypt(originalText, 'linkedin_password', {
      workspaceId,
    });

    expect(secretId).toBeDefined();
    expect(typeof secretId).toBe('string');

    // Verify it is encrypted in DB (read under workspace context)
    await withWorkspace(workspaceId, async (trx) => {
      const secretRow = await trx
        .selectFrom('secrets')
        .selectAll()
        .where('id', '=', secretId)
        .executeTakeFirstOrThrow();

      expect(secretRow.ciphertext).not.toBe(originalText);
    });

    // Decrypt (with workspace context)
    const decryptedText = await secretsService.decrypt(secretId, { workspaceId });
    expect(decryptedText).toBe(originalText);

    // Cleanup
    await secretsService.remove(secretId, workspaceId);
  });
});
