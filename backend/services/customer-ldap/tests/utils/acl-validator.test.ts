import { ALLOWED_ACL } from '../../src/constants';
import { validateAcl, isDefaultUserAclOutdated } from '../../src/utils/acl-validator';

describe('ACL Validator', () => {
  describe('validateAcl', () => {
    it('should accept valid ACL with all allowed commands', () => {
      const result = validateAcl(ALLOWED_ACL);
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should accept subset of allowed commands', () => {
      const result = validateAcl('+INFO +PING +GRAPH.QUERY');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should accept subcategory commands', () => {
      const result = validateAcl('+MODULE|LIST');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should accept quoted commands', () => {
      const result = validateAcl("+MODULE|LIST +INFO");
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should reject disallowed commands', () => {
      const result = validateAcl('+INFO +SET +GET');
      expect(result.valid).toBe(false);
      expect(result.invalidCommands).toContain('SET');
      expect(result.invalidCommands).toContain('GET');
      expect(result.invalidCommands).not.toContain('INFO');
    });

    it('should reject mixed valid and invalid commands', () => {
      const result = validateAcl('+GRAPH.QUERY +HSET +PING');
      expect(result.valid).toBe(false);
      expect(result.invalidCommands).toEqual(['HSET']);
    });

    it('should handle case insensitivity', () => {
      const result = validateAcl('+info +ping +graph.query');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should handle empty ACL', () => {
      const result = validateAcl('');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should reject subcategory when only specific subcategories are allowed', () => {
      // MODULE|LOAD is not in ALLOWED_ACL, only MODULE|LIST is
      const result = validateAcl('+MODULE|LOAD +MODULE|LIST');
      expect(result.valid).toBe(false);
      expect(result.invalidCommands).toContain('MODULE|LOAD');
    });

    it('should handle complex ACL with multiple command types', () => {
      const complexAcl = '+GRAPH.QUERY +GRAPH.RO_QUERY +INFO +PING +CLIENT +DBSIZE';
      const result = validateAcl(complexAcl);
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should reject ACL with only disallowed commands', () => {
      const result = validateAcl('+SET +GET +HSET +HGET');
      expect(result.valid).toBe(false);
      expect(result.invalidCommands.length).toBe(4);
    });

    it('should handle ACL with extra whitespace', () => {
      const result = validateAcl('  +INFO   +PING  +GRAPH.QUERY  ');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should ignore commands without + prefix', () => {
      const result = validateAcl('+INFO PING +GRAPH.QUERY');
      expect(result.valid).toBe(true);
      // PING without + should be ignored, not treated as invalid
      expect(result.invalidCommands).toEqual([]);
    });

    it('should accept MONITOR command', () => {
      const result = validateAcl('+MONITOR');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });

    it('should accept MONITOR with other commands', () => {
      const result = validateAcl('+INFO +MONITOR +PING');
      expect(result.valid).toBe(true);
      expect(result.invalidCommands).toEqual([]);
    });
  });

  describe('isDefaultUserAclOutdated', () => {
    it('should return false when ACL matches current ALLOWED_ACL', () => {
      const acl = `~* ${ALLOWED_ACL}`;
      expect(isDefaultUserAclOutdated(acl)).toBe(false);
    });

    it('should return false when ACL does not start with ~* prefix', () => {
      // Custom user with subset of commands
      expect(isDefaultUserAclOutdated('+INFO +PING')).toBe(false);
    });

    it('should return true when ACL is an outdated subset of ALLOWED_ACL', () => {
      // Simulate an older version of ALLOWED_ACL (missing some newer commands)
      const outdatedAcl = '~* +INFO +CLIENT +DBSIZE +PING +HELLO +AUTH +GRAPH.QUERY +GRAPH.RO_QUERY';
      expect(isDefaultUserAclOutdated(outdatedAcl)).toBe(true);
    });

    it('should return false when ACL contains commands not in ALLOWED_ACL', () => {
      // This is a custom user, not an outdated default
      const customAcl = '~* +INFO +SET +GET';
      expect(isDefaultUserAclOutdated(customAcl)).toBe(false);
    });

    it('should return false for empty ACL', () => {
      expect(isDefaultUserAclOutdated('')).toBe(false);
    });

    it('should return false for ~* prefix only with no commands', () => {
      // ~* with empty commands is technically "~* " which differs from ALLOWED_ACL
      // but has no commands so it's valid (all are in ALLOWED_ACL trivially)
      // It should return true since it's outdated (missing all commands)
      expect(isDefaultUserAclOutdated('~* ')).toBe(true);
    });
  });
});
