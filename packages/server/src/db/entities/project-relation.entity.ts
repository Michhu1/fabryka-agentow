import type { ProjectRole } from '@app/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Project } from './project.entity.js';
import { User } from './user.entity.js';

/** Membership of a user in a project with a role. The only source of truth for project access. */
@Entity({ name: 'project_relation' })
@Index('IDX_project_relation_user_id', ['userId'])
@Index('UQ_project_relation_personal_owner', ['userId'], {
  unique: true,
  where: `role = 'project:personalOwner'`,
})
/**
 * A team project has exactly one owner (`project:admin`); "at least one" is kept by the project service
 * and the transfer accept (which demotes the old owner and promotes the recipient in one transaction).
 */
@Index('UQ_project_relation_one_admin', ['projectId'], {
  unique: true,
  where: `role = 'project:admin'`,
})
export class ProjectRelation {
  @PrimaryColumn({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  role!: ProjectRole;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'FK_project_relation_project_id' })
  project?: Project;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_project_relation_user_id' })
  user?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
