import { api } from '@/lib/axios';

export const ledgerService = {
  list: (w: string, c: string, p?: Record<string, unknown>) =>
    api.get(`/v1/workspaces/${w}/containers/${c}/ledger`, { params: p }).then(r => r.data),

  create: (w: string, c: string, p: Record<string, unknown>, force?: boolean) =>
    api
      .post(`/v1/workspaces/${w}/containers/${c}/ledger${force ? '?force=true' : ''}`, p)
      .then(r => r.data),

  update: (w: string, c: string, e: string, p: Record<string, unknown>) =>
    api.patch(`/v1/workspaces/${w}/containers/${c}/ledger/${e}`, p).then(r => r.data),

  getUploadProofUrl: (w: string, c: string, e: string, f: Record<string, unknown>) =>
    api.post(`/v1/workspaces/${w}/containers/${c}/ledger/${e}/upload-proof`, f).then(r => r.data),

  // Fixed: payload now matches backend confirmProofSchema (name, size, mime_type — not filename)
  confirmProof: (
    w: string,
    c: string,
    e: string,
    p: { file_path: string; name: string; size: number; mime_type: string },
  ) =>
    api
      .post(`/v1/workspaces/${w}/containers/${c}/ledger/${e}/confirm-proof`, p)
      .then(r => r.data),

  confirm: (w: string, c: string, e: string, p?: { notes?: string }) =>
    api
      .post(`/v1/workspaces/${w}/containers/${c}/ledger/${e}/confirm`, p ?? {})
      .then(r => r.data),

  // Fixed: supports optional file_index query param for multi-proof entries
  getProofUrl: (w: string, c: string, e: string, fileIndex?: number) =>
    api
      .get(`/v1/workspaces/${w}/containers/${c}/ledger/${e}/proof-url`, {
        params: fileIndex != null ? { file_index: fileIndex } : undefined,
      })
      .then(r => r.data),

  // Added: was missing entirely
  addCorrection: (w: string, c: string, e: string, p: Record<string, unknown>) =>
    api
      .post(`/v1/workspaces/${w}/containers/${c}/ledger/${e}/add-correction`, p)
      .then(r => r.data),

  export: (w: string, p?: Record<string, unknown>) =>
    api.get(`/v1/workspaces/${w}/ledger/export`, { params: p }).then(r => r.data),
};
