import { useEffect } from 'react';
import { useForm } from '@mantine/form';
import { Button, Modal, MultiSelect, NumberInput, Select, Text, TextInput, Textarea } from '@mantine/core';
import { z } from 'zod';
import type { Project } from './projects';
import { loadWorkflows } from './workflowModel';
import { useQuery } from '@tanstack/react-query';

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  configuration_revision: z.number().int().nonnegative().optional(),
  default_workflow_id: z.string().optional(),
  monthly_budget_cents: z.number().int().nonnegative().optional(),
  repository_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export const productsSchema = z.array(productSchema);
export const productInputSchema = z.object({
  name: z.string().trim().min(1, 'Add a product name').max(100),
  description: z.string().max(2000),
  default_workflow_id: z.string(),
  monthly_budget_cents: z.number().int().min(0).max(1_000_000_000, 'Budget must be at most $10,000,000'),
  repository_ids: z.array(z.string()),
});
export type Product = z.infer<typeof productSchema>;
export type ProductInput = z.infer<typeof productInputSchema>;

export async function loadProducts() {
  const response = await fetch('/api/v1/products');
  if (!response.ok) throw new Error(`Could not load products (${response.status})`);
  return productsSchema.parse(await response.json());
}

type ProductEditorProps = {
  opened: boolean;
  live: boolean;
  product: Pick<Product, 'id' | 'name' | 'description' | 'repository_ids' | 'default_workflow_id'
    | 'monthly_budget_cents'> | undefined;
  projects: Project[] | undefined;
  /** Why repositories cannot be linked here; the picker is disabled while it is set. */
  repositoryNote?: string;
  onClose: () => void;
  onSave: (input: ProductInput) => void;
  isSaving: boolean;
  error: string;
};

export function ProductEditor({
  opened, live, product, projects, repositoryNote, onClose, onSave, isSaving, error,
}: ProductEditorProps) {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled: opened && live });
  const form = useForm<ProductInput>({
    initialValues: { name: '', description: '', repository_ids: [], default_workflow_id: '', monthly_budget_cents: 0 },
    validate: (values) => {
      const result = productInputSchema.safeParse(values);
      return result.success
        ? {}
        : Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
    },
  });

  useEffect(() => {
    if (!opened) return;
    form.setValues({
      name: product?.name ?? '',
      description: product?.description ?? '',
      repository_ids: product?.repository_ids ?? [],
      default_workflow_id: product?.default_workflow_id ?? '',
      monthly_budget_cents: product?.monthly_budget_cents ?? 0,
    });
  }, [opened, product?.id]);

  const repositoryOptions = [
    ...(projects?.map((project) => ({ value: project.id, label: `${project.name} · ${project.worker_name}` })) ?? []),
    ...form.values.repository_ids.filter((id) => !projects?.some((project) => project.id === id)).map((id) => ({
      value: id,
      label: `Unavailable repository · ${id.slice(0, 8)}`,
    })),
  ];

  return (
    <Modal opened={opened} onClose={onClose} title={product ? 'Edit product' : 'Add product'} centered>
      <form onSubmit={form.onSubmit((values) => onSave(productInputSchema.parse(values)))}>
        <TextInput label="Product name" required {...form.getInputProps('name')} />
        <Textarea label="Description" mt="sm" autosize minRows={2} maxRows={4}
          {...form.getInputProps('description')} />
        {live && <>
          <Select label="Default workflow for new objectives" placeholder="Choose when proposing a plan"
            data={workflows.data?.map((workflow) => ({ value: workflow.id, label: workflow.name })) ?? []}
            clearable mt="sm" value={form.values.default_workflow_id || null}
            onChange={(value) => form.setFieldValue('default_workflow_id', value ?? '')}
            disabled={workflows.isLoading || workflows.isError} />
          {workflows.isError && <Text className="form-error" role="alert">Workflow definitions could not be loaded.</Text>}
          <NumberInput label="Monthly budget (USD)" mt="sm" min={0} max={10_000_000} decimalScale={2}
            placeholder="No budget"
            description="Reporting only: shown against provider-reported cost, never enforced."
            value={form.values.monthly_budget_cents ? form.values.monthly_budget_cents / 100 : ''}
            onChange={(value) => form.setFieldValue('monthly_budget_cents',
              typeof value === 'number' ? Math.round(value * 100) : 0)}
            error={form.errors.monthly_budget_cents} />
        </>}
        <MultiSelect
          label="Repositories"
          description={repositoryNote ?? 'Only repository names and worker IDs are shared with the control plane.'}
          disabled={Boolean(repositoryNote)}
          data={repositoryOptions}
          searchable
          clearable
          mt="sm"
          {...form.getInputProps('repository_ids')}
        />
        {error && <Text className="form-error" role="alert">{error}</Text>}
        <div className="workspace-form-actions">
          <Button variant="subtle" type="button" onClick={onClose}>Cancel</Button>
          <Button className="workspace-mock-add" type="submit" loading={isSaving}>Save product</Button>
        </div>
      </form>
    </Modal>
  );
}
