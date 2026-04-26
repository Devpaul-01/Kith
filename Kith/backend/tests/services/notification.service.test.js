const { renderTemplate } = require('../../src/services/notification.service');

describe('renderTemplate', () => {

  test('should replace all variable placeholders with values', () => {
    // ARRANGE
    const template  = '{actor} submitted {amount} for {container}';
    const variables = { actor: 'Alice', amount: '£100', container: 'Wedding Fund' };

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Alice submitted £100 for Wedding Fund');
  });

  test('should replace only present variables', () => {
    // ARRANGE
    const template  = 'Hi {name}, your {amount} is due';
    const variables = { name: 'Bob' }; // amount is missing

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Hi Bob, your {amount} is due');
  });

  test('should handle null variable values gracefully', () => {
    // ARRANGE
    const template  = 'Hello {name}';
    const variables = { name: null };

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Hello ');
  });
  test('debug: see raw output', () => {
  const result = renderTemplate('Hi {name}, your {amount} is due', { name: 'Bob' });
  console.log('RESULT:', JSON.stringify(result));
  expect(true).toBe(true); // Just to see output
});

});