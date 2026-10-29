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
import { Project } from './project.entity.js';
import { User } from './user.entity.js';

/**
 * A pending hand-over of a team project from its owner to an email address, accepted by the recipient
 * through a one-time link. One per project: a new request replaces the old one (and its link).
 */
@Entity({ name: 'project_transfer' })
@Unique('UQ_project_transfer_project_id', ['projectId'])
@Unique('UQ_project_transfer_token_hash', ['tokenHash'])
export class ProjectTransfer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'FK_project_transfer_project_id' })
  project?: Project;

  /** The owner who asked for the transfer. */
  @Index('IDX_project_transfer_from_user_id')
  @Column({ name: 'from_user_id', type: 'uuid' })
  fromUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'from_user_id', foreignKeyConstraintName: 'FK_project_transfer_from_user_id' })
  fromUser?: User;

  /** Always stored normalized (`trim().toLowerCase()`). */
  @Column({ name: 'to_email', type: 'varchar', length: 254 })
  toEmail!: string;

  /** sha256 hex of the link's token, never the token itself. */
  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
