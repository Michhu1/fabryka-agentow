import type { MemberRole } from '@app/shared';
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
 * A pending invitation of an email address to a team project, accepted by the invited person through a
 * one-time link. One per project and address; accepting or cancelling deletes it.
 */
@Entity({ name: 'project_invitation' })
@Unique('UQ_project_invitation_token_hash', ['tokenHash'])
@Unique('UQ_project_invitation_project_email', ['projectId', 'email'])
export class ProjectInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'FK_project_invitation_project_id' })
  project?: Project;

  /** Always stored normalized (`trim().toLowerCase()`). */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar', length: 32 })
  role!: MemberRole;

  /** sha256 hex of the link's token, never the token itself. */
  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  /** The owner who sent it; null once that account is deleted. */
  @Index('IDX_project_invitation_invited_by')
  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by', foreignKeyConstraintName: 'FK_project_invitation_invited_by' })
  inviter?: User | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
