import type { ProjectIcon, ProjectType } from '@app/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';

/** A space that owns workflows and credentials: one `personal` per user, any number of `team` ones. */
@Entity({ name: 'project' })
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: ProjectType;

  @Column({ type: 'jsonb', nullable: true })
  icon!: ProjectIcon | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  /** Set to null when the creator's account is deleted; membership lives in `project_relation`. */
  @Column({ name: 'creator_id', type: 'uuid', nullable: true })
  creatorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'creator_id', foreignKeyConstraintName: 'FK_project_creator_id' })
  creator?: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
