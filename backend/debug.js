// debug.js
function renderTemplate(template, variables) {
  let text = template;
  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return text;
}

const template = 'Hi {name}, your {amount} is due';
const variables = { name: 'Bob' };

const result = renderTemplate(template, variables);

console.log('RESULT:', JSON.stringify(result));
console.log('EXPECTED:', JSON.stringify('Hi Bob, your  is due'));
console.log('MATCH?', result === 'Hi Bob, your  is due');