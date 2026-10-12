import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, User, Box } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { searchService } from '@/services/search.service';
import { useDebounce } from '@/hooks/useDebounce';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

export function GlobalSearchModal({ open, onClose, workspaceId }: Props) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const dQuery = useDebounce(query, 300);

  const { data, isFetching } = useQuery({
    queryKey: ['search', workspaceId, dQuery],
    queryFn: () => searchService.search(workspaceId, dQuery),
    enabled: open && dQuery.trim().length >= 2,
  });

  const results = data?.results ?? [];

  function handleSelect(result: NonNullable<typeof data>['results'][number]) {
    onClose();
    setQuery('');
    if (result.type === 'member') {
      nav(`/app/members/${result.id}`);
    } else {
      nav(`/app/containers/${result.id}`);
    }
  }

  function handleClose() {
    onClose();
    setQuery('');
  }

  return (
    <Modal open={open} onClose={handleClose} title="Search">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            autoFocus
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary bg-white"
            placeholder="Search members or events..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {query.trim().length > 0 && query.trim().length < 2 && (
          <p className="text-xs text-text-secondary px-1">Keep typing — at least 2 characters.</p>
        )}

        {isFetching && (
          <div className="flex justify-center py-4"><Spinner size="sm" /></div>
        )}

        {!isFetching && dQuery.trim().length >= 2 && results.length === 0 && (
          <p className="text-sm text-text-secondary px-1 py-2">No matches for "{dQuery}"</p>
        )}

        {!isFetching && results.length > 0 && (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {results.map(r => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => handleSelect(r)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 text-left transition-colors"
              >
                {r.type === 'member' ? (
                  <User size={16} className="text-text-secondary shrink-0" />
                ) : (
                  <Box size={16} className="text-text-secondary shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {r.type === 'member' ? r.display_name : r.name}
                  </p>
                  <p className="text-xs text-text-secondary capitalize">
                    {r.type === 'member' ? r.role : r.container_type}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
