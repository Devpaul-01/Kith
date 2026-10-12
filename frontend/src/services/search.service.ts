import { api } from '@/lib/axios';

export interface MemberSearchResult {
  type: 'member';
  id: string;
  display_name: string;
  role: string;
  is_proxy: boolean;
}

export interface ContainerSearchResult {
  type: 'container';
  id: string;
  name: string;
  container_type: string;
  status: string;
}

export type SearchResult = MemberSearchResult | ContainerSearchResult;

export const searchService = {
  search: (workspaceId: string, q: string, limit?: number): Promise<{ results: SearchResult[]; query: string }> =>
    api
      .get(`/v1/workspaces/${workspaceId}/search`, { params: { q, limit } })
      .then(r => r.data),
};
