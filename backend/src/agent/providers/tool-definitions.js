const { zodToJsonSchema } = require('zod-to-json-schema');
const { ValidationError } = require('../../utils/errors');
const { toolDefinitionsSchema } = require('../validators/groq.validator');

/** Convert only the definitions already filtered by the read loop's role gate. */
function serializeToolDefinitions(tools) {
  const parsed = toolDefinitionsSchema.safeParse(tools);
  if (!parsed.success) throw new ValidationError('Invalid provider tool definitions');

  return parsed.data.map(({ name, description, parameterSchema }) => {
    let schema;
    try {
      schema = zodToJsonSchema(parameterSchema, {
        target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: 'input',
      });
    } catch {
      throw new ValidationError('Unable to serialize provider tool parameters');
    }
    if (schema.type !== 'object') throw new ValidationError('Provider tool parameters must be an object');
    const { $schema, ...parameters } = schema;
    return { type: 'function', function: { name, description, parameters } };
  });
}

module.exports = { serializeToolDefinitions };
