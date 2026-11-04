import { useEffect } from 'react';
import { useForm } from '@mantine/form';
import { Button, Modal, MultiSelect, Text, TextInput, Textarea } from '@mantine/core';
import { z } from 'zod';
import type { Project } from './projects';

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  repository_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export const productsSchema = z.array(productSchema);
export const productInputSchema = z.object({
  name: z.string().trim().min(1, 'Add a product name').max(100),
  description: z.string().max(2000),
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
  product: Product | undefined;
  projects: Project[] | undefined;
  onClose: () => void;
  onSave: (input: ProductInput) => void;
  isSaving: boolean;
  error: string;
};

export function ProductEditor({ opened, product, projects, onClose, onSave, isSaving, error }: ProductEditorProps) {
  const form = useForm<ProductInput>({
    initialValues: { name: '', description: '', repository_ids: [] },
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
        <MultiSelect
          label="Repositories"
          description="Only repository names and worker IDs are shared with the control plane."
          data={repositoryOptions}
          searchable
          clearable
          mt="sm"
          {...form.getInputProps('repository_ids')}
        />
        {error && <Text className="form-error" role="alert">{error}</Text>}
        <div className="workspace-form-actions">
          <Button variant="subtle" type="button" onClick={onClose}>Cancel</Button>
          <Button className="workspace-add-product" type="submit" loading={isSaving}>Save product</Button>
        </div>
      </form>
    </Modal>
  );
}
