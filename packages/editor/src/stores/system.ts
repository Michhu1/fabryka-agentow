import { defineStore } from 'pinia';
import { apiClient } from '../api/client';

type VersionInfo = { name: string; version: string };

export const useSystemStore = defineStore('system', {
  state: () => ({
    version: null as string | null,
    ready: null as boolean | null,
  }),
  actions: {
    async load() {
      const [version, ready] = await Promise.all([
        apiClient
          .get<VersionInfo>('/rest/version')
          .then((info) => `${info.name} ${info.version}`)
          .catch(() => null),
        apiClient
          .get('/healthz/readiness')
          .then(() => true)
          .catch(() => false),
      ]);
      this.version = version;
      this.ready = ready;
    },
  },
});
