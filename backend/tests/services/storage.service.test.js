const { validateUpload } = require('../../src/services/storage.service');
const { BusinessRuleError } = require('../../src/utils/errors');

describe('validateUpload', () => {

  describe('when the file type is unknown', () => {
    test('should throw BusinessRuleError', () => {
      // ARRANGE
      const fileType    = 'unknown_type';
      const contentType = 'image/jpeg';
      const fileSize    = 1024;

      // ACT & ASSERT (for functions that throw, you wrap the call)
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);

      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow('Unknown file type: unknown_type');
    });
  });

  describe('when the file exceeds the size limit', () => {
    test('should throw BusinessRuleError for avatar over 5MB', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'image/jpeg';
      const fileSize    = 6 * 1024 * 1024; // 6MB — over the 5MB limit

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);
    });

    test('should NOT throw for avatar exactly at 5MB', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'image/jpeg';
      const fileSize    = 5 * 1024 * 1024; // exactly 5MB

      // ACT & ASSERT — we expect this NOT to throw
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).not.toThrow();
    });
  });

  describe('when content type is not allowed', () => {
    test('should throw for pdf avatar (pdf not in avatar allowed types)', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'application/pdf'; // not allowed for avatar
      const fileSize    = 1024;

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);
    });

    test('should NOT throw for valid proof with pdf content type', () => {
      // ARRANGE — 'proof' type does allow application/pdf
      const fileType    = 'proof';
      const contentType = 'application/pdf';
      const fileSize    = 1024;

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).not.toThrow();
    });
  });

});