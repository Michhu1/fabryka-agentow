import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Instance-wide key/value settings (same idea as n8n's `settings` table). */
@Entity({ name: 'settings' })
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @Column({ type: 'boolean', default: false })
  loadOnStartup!: boolean;
}
