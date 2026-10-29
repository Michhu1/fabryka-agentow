import { randomUUID } from 'node:crypto';
import type { ProjectRole } from '@app/shared';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../db/entities/project.entity.js';
import { HttpError } from '../http/errors.js';
import { assertRole, createProjectAccess, ROLE_RANK } from './project-access.js';

const PROJECT = { id: randomUUID(), name: 'Zespół', type: 'team' } as Project;

/**
 * A DataSource whose project_relation repository answers `findOne` with `relation`, and whose raw
 * query (the "is the owner disabled" check) answers `blocked`.
 */
function fakeDataSource(relation: { role: ProjectRole; project: Project } | null, blocked = false) {
  const findOne = vi.fn(async () => relation);
  const query = vi.fn(async () => [{ blocked }]);
  const dataSource = { getRepository: () => ({ findOne }), query } as unknown as DataSource;
  return { dataSource, findOne, query };
}

async function errorOf(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected an HttpError');
}

describe('ROLE_RANK', () => {
  it('orders viewer < editor < admin = personalOwner', () => {
    expect(ROLE_RANK['project:viewer']).toBeLessThan(ROLE_RANK['project:editor']);
    expect(ROLE_RANK['project:editor']).toBeLessThan(ROLE_RANK['project:admin']);
    expect(ROLE_RANK['project:admin']).toBe(ROLE_RANK['project:personalOwner']);
  });
});

describe('assertRole', () => {
  it('no membership → 404 Project not found', () => {
    expect(() => assertRole(undefined, 'project:viewer')).toThrow(
      expect.objectContaining({ status: 404, message: 'Project not found' }),
    );
  });

  it('a lower role → 403 Forbidden', () => {
    expect(() => assertRole('project:viewer', 'project:editor')).toThrow(
      expect.objectContaining({ status: 403, message: 'Forbidden' }),
    );
    expect(() => assertRole('project:editor', 'project:admin')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('the same or a higher role passes; personalOwner counts as admin', () => {
    expect(() => assertRole('project:viewer', 'project:viewer')).not.toThrow();
    expect(() => assertRole('project:admin', 'project:editor')).not.toThrow();
    expect(() => assertRole('project:personalOwner', 'project:admin')).not.toThrow();
  });
});

describe('createProjectAccess().require', () => {
  it('viewer asking for project:editor → 403', async () => {
    const { dataSource } = fakeDataSource({ role: 'project:viewer', project: PROJECT });
    const error = await errorOf(
      createProjectAccess(dataSource).require(randomUUID(), PROJECT.id, 'project:editor'),
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe('Forbidden');
  });

  it('no membership (or no such project) → 404 Project not found', async () => {
    const { dataSource } = fakeDataSource(null);
    const error = await errorOf(
      createProjectAccess(dataSource).require(randomUUID(), PROJECT.id, 'project:viewer'),
    );
    expect(error.status).toBe(404);
    expect(error.message).toBe('Project not found');
  });

  it('an id that is not a uuid → the same 404 without a query', async () => {
    const { dataSource, findOne } = fakeDataSource({ role: 'project:admin', project: PROJECT });
    for (const id of ['abc', '1', `${PROJECT.id}x`, "' OR 1=1 --"]) {
      const error = await errorOf(
        createProjectAccess(dataSource).require(randomUUID(), id, 'project:viewer'),
      );
      expect(error.status).toBe(404);
      expect(error.message).toBe('Project not found');
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it("a blocked project (its owner's account is disabled) → the same 404 for every member, never 403", async () => {
    for (const [role, minRole] of [
      ['project:admin', 'project:admin'],
      ['project:editor', 'project:viewer'],
      ['project:viewer', 'project:editor'],
    ] as const) {
      const { dataSource } = fakeDataSource({ role, project: PROJECT }, true);
      const error = await errorOf(createProjectAccess(dataSource).require(randomUUID(), PROJECT.id, minRole));
      expect(error.status).toBe(404);
      expect(error.message).toBe('Project not found');
    }
  });

  it('a stranger is refused without the block check', async () => {
    const { dataSource, query } = fakeDataSource(null, true);
    expect(
      (await errorOf(createProjectAccess(dataSource).require(randomUUID(), PROJECT.id, 'project:viewer')))
        .status,
    ).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('enough rank → the project and the role', async () => {
    const { dataSource } = fakeDataSource({ role: 'project:editor', project: PROJECT });
    const result = await createProjectAccess(dataSource).require(randomUUID(), PROJECT.id, 'project:viewer');
    expect(result).toEqual({ project: PROJECT, role: 'project:editor' });
  });
});
