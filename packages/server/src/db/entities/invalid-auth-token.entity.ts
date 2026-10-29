import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Revoked session tokens (logout) until they would expire anyway; expired rows can be pruned. */
@Entity({ name: 'invalid_auth_token' })
export class InvalidAuthToken {
  /** sha256 hex of the token id, never the token itself. */
  @PrimaryColumn({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @Index('IDX_invalid_auth_token_expires_at')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
