import type { GlobalRole, UserSettings } from '@app/shared';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/** An account. `passwordHash` is null for an invited user who has not set a password yet. */
@Entity({ name: 'user' })
@Unique('UQ_user_email', ['email'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Always stored normalized (`trim().toLowerCase()`). */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ name: 'first_name', type: 'varchar', length: 32 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 32 })
  lastName!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true })
  passwordHash!: string | null;

  @Column({ type: 'varchar', length: 32 })
  role!: GlobalRole;

  @Column({ type: 'boolean', default: false })
  disabled!: boolean;

  @Column({ name: 'mfa_enabled', type: 'boolean', default: false })
  mfaEnabled!: boolean;

  /** TOTP secret, encrypted with the data-encryption key. */
  @Column({ name: 'mfa_secret', type: 'text', nullable: true })
  mfaSecret!: string | null;

  /** Encrypted JSON array of sha256 hashes of the unused recovery codes. */
  @Column({ name: 'mfa_recovery_codes', type: 'text', nullable: true })
  mfaRecoveryCodes!: string | null;

  @Column({ type: 'jsonb', default: {} })
  settings!: UserSettings;

  /** Own team project limit (later raised by a paid plan); NULL = the instance default `TEAM_PROJECTS_LIMIT`. */
  @Column({ name: 'team_projects_limit', type: 'integer', nullable: true })
  teamProjectsLimit!: number | null;

  /** Day granularity is enough for "last active" and avoids a write on every request. */
  @Column({ name: 'last_active_at', type: 'date', nullable: true })
  lastActiveAt!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
