import { HttpStatus } from '@nestjs/common';
import { VerificationController } from './verification.controller';

/**
 * POST /verification/rider-terms/accept answers 200.
 *
 * Nest's default for a POST is 201 "Created". Accepting the terms creates
 * nothing a client is given a location for, and every comparable action POST
 * in the API (orders, rider, auth) is declared 200; the API walk expects 200.
 */
describe('POST /verification/rider-terms/accept', () => {
  it('is declared to answer 200, not the POST default of 201', () => {
    const handler = VerificationController.prototype.acceptRiderTerms;
    expect(Reflect.getMetadata('path', handler)).toBe('rider-terms/accept');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
  });

  it('leaves submit, which does create a submission, on 201', () => {
    expect(
      Reflect.getMetadata('__httpCode__', VerificationController.prototype.submit),
    ).toBeUndefined();
  });
});
