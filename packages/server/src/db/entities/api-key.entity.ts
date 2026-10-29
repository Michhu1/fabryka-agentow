import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';

/** A public API key. Only its sha256 hash and a short hint are stored; the key is shown once. */
@Entity({ name: 'api_key' })
@Unique('UQ_api_key_key_hash', ['keyHash'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_api_key_user_id')
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_api_key_user_id' })
  user?: User;

  @Column({ type: 'varchar', length: 100 })
  label!: string;

  @Column({ name: 'key_hash', type: 'varchar', length: 64 })
  keyHash!: string;

  /** Last 4 characters of the key, so the user can tell keys apart. */
  @Column({ type: 'varchar', length: 8 })
  hint!: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
