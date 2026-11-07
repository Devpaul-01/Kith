const { z } = require('zod');
const { serializeToolDefinitions } = require('../../../src/agent/providers/tool-definitions');
const { entitySearchSchema } = require('../../../src/validators/search.validator');
const { ValidationError } = require('../../../src/utils/errors');

function definition(parameterSchema = entitySearchSchema) {
  return { name: 'find_member', description: 'Find member candidates.', parameterSchema };
}

describe('provider tool definitions', () => {
  it('converts the real search schema with bounds, defaults, and strict properties', () => {
    const [tool] = serializeToolDefinitions([definition()]);
    expect(tool).toEqual({
      type: 'function',
      function: {
        name: 'find_member', description: 'Find member candidates.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, maxLength: 200 },
            limit: { type: 'integer', minimum: 2, maximum: 20, default: 10 },
          },
          required: ['query'], additionalProperties: false,
        },
      },
    });
    expect(JSON.stringify(tool)).not.toMatch(/parameterSchema|safeParse|handler|\$schema/);
    expect(entitySearchSchema.safeParse({ query: 'Adaeze', workspaceId: 'forged' }).success).toBe(false);
  });

  it('supports the empty argument objects used by context and dashboard tools', () => {
    const [tool] = serializeToolDefinitions([definition(z.object({}).strict())]);
    expect(tool.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(serializeToolDefinitions([])).toEqual([]);
  });

  it('serializes refined input shapes while leaving refinement enforcement to Zod', () => {
    const schema = z.object({ query: z.string().min(2) }).strict().refine((value) => value.query !== 'blocked');
    const [tool] = serializeToolDefinitions([definition(schema)]);
    expect(tool.function.parameters.properties.query).toEqual({ type: 'string', minLength: 2 });
    expect(schema.safeParse({ query: 'blocked' }).success).toBe(false);
  });

  it.each([
    null, [{}], [definition(), definition()],
    [{ ...definition(), name: 'bad name' }],
    [{ ...definition(), handler: () => {} }],
    [{ ...definition(), parameterSchema: { type: 'object' } }],
    [definition(z.string())],
    Array.from({ length: 129 }, (_, index) => ({ ...definition(), name: `tool_${index}` })),
  ])('rejects invalid definitions instead of sending incomplete schemas', (tools) => {
    expect(() => serializeToolDefinitions(tools)).toThrow(ValidationError);
  });
});
