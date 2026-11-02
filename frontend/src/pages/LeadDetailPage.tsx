import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, SearchX } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PanelLoading } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import {
  AiAnalysisPanel,
  BusinessInfoPanel,
  LeadInfoPanel,
  PipelinePanel,
  WebsiteAnalysisSectionPanel,
} from '../components/leads/LeadDetailSections';
import { SalesIntelligenceSection } from '../components/leads/SalesIntelligencePanel';
import { ContactsPanel } from '../components/leads/ContactsPanel';
import {
  fetchLeadDetail,
  updateLeadPipelineStage,
  updateLeadSalesNotes,
  type LeadDetail,
} from '../lib/api';
import type { LeadPipelineStage } from '../types';

type LeadDetailState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detail: LeadDetail };

/**
 * Phase 13B1B: loading, error, and ready states for GET /api/leads/:id.
 * The ready state renders the five real data sections
 * (business/website analysis/AI analysis/lead info/pipeline) from
 * whatever the API actually returned -- every field is read
 * defensively (business may be missing on a malformed response; each
 * sub-section may be null) and nothing here fabricates a value or a
 * zero for data the backend didn't provide.
 *
 * Phase 19 Part 2: once the lead has loaded, the Sales Intelligence
 * panel loads GET /api/leads/:id/intelligence independently (see
 * SalesIntelligenceSection) -- it has its own loading/error/empty
 * states and can never turn a working lead page into an error page.
 *
 * Phase 13B2: pipeline stage and sales notes are now editable. Both
 * writes go through the real lead ID (`id` from the route, which is
 * also `state.detail.lead.id`/`pipeline.lead_id`) and, on success,
 * splice the persisted row back into `state.detail` so the page
 * reflects exactly what the backend saved -- never an optimistic
 * guess. On failure the previous value stays displayed; the error
 * itself is shown by the panel that attempted the save.
 */
export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LeadDetailState>({ status: 'loading' });

  useEffect(() => {
    if (!id) {
      setState({ status: 'error', message: 'No lead ID provided.' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    fetchLeadDetail(id).then((result) => {
      if (cancelled) return;

      if (!result.ok) {
        setState(
          result.notFound
            ? { status: 'not-found' }
            : { status: 'error', message: result.error },
        );
        return;
      }

      setState({ status: 'ready', detail: result.detail });
    });

    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * Phase 13B2. Throws on failure so PipelinePanel can show the error
   * and leave the previous stage displayed -- this function never
   * writes optimistic state itself.
   */
  async function handleStageChange(stage: LeadPipelineStage) {
    if (!id) throw new Error('No lead ID available.');
    const result = await updateLeadPipelineStage(id, stage);
    if (!result.ok) {
      throw new Error(result.error);
    }
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, detail: { ...prev.detail, pipeline: result.data } } : prev,
    );
  }

  /**
   * Phase 13B2. Same contract as handleStageChange, for sales_notes.
   */
  async function handleSaveNotes(notes: string) {
    if (!id) throw new Error('No lead ID available.');
    const result = await updateLeadSalesNotes(id, notes);
    if (!result.ok) {
      throw new Error(result.error);
    }
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, detail: { ...prev.detail, lead: result.data } } : prev,
    );
  }

  return (
    <div>
      <PageHeader
        title="Lead detail"
        description={id ? `Lead ID: ${id}` : 'No lead ID provided.'}
        actions={
          <Link
            to="/leads"
            className="inline-flex items-center gap-1.5 rounded border border-surface-border px-2.5 py-1.5 text-sm font-medium text-ink-600 hover:bg-surface-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to leads
          </Link>
        }
      />

      {state.status === 'loading' && <PanelLoading label="Loading lead…" />}

      {state.status === 'not-found' && (
        <EmptyState
          icon={<SearchX className="h-8 w-8" />}
          title="Lead not found"
          description="This lead doesn't exist, or may have been removed."
        />
      )}

      {state.status === 'error' && (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Couldn't load this lead"
          description={state.message}
        />
      )}

      {state.status === 'ready' &&
        (state.detail.business ? (
          <div className="flex flex-col gap-4">
            <BusinessInfoPanel business={state.detail.business} />
            {/* Renders nothing when the response carries no `contacts` block (older server). */}
            <ContactsPanel contacts={state.detail.contacts} />
            {/* Phase 19 Part 2. Fetches its own data, so a failure here never affects the panels around it. */}
            {id && <SalesIntelligenceSection leadId={id} />}
            <WebsiteAnalysisSectionPanel
              websiteStatus={state.detail.business.website_status}
              analysis={state.detail.website_analysis ?? null}
            />
            <AiAnalysisPanel analysis={state.detail.ai_analysis ?? null} />
            <LeadInfoPanel lead={state.detail.lead} scoring={state.detail.scoring} onSaveNotes={handleSaveNotes} />
            {state.detail.pipeline && (
              <PipelinePanel pipeline={state.detail.pipeline} onChangeStage={handleStageChange} />
            )}
          </div>
        ) : (
          // Defensive fallback: a 200 whose body passed the loose runtime
          // shape check (a `lead.id` is present) but is otherwise missing
          // the `business` object it should always carry. Never invents
          // business/website/AI data to fill the gap.
          <EmptyState
            icon={<AlertTriangle className="h-8 w-8" />}
            title="Couldn't load this lead"
            description="The server returned this lead without its business details."
          />
        ))}
    </div>
  );
}
