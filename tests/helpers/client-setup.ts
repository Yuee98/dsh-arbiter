import {
  toAppearAfter,
  toAppearBefore,
  toBeChecked,
  toBeDisabled,
  toBeEmptyDOMElement,
  toBeEnabled,
  toBeInTheDocument,
  toBeInvalid,
  toBePartiallyChecked,
  toBePartiallyPressed,
  toBePressed,
  toBeRequired,
  toBeValid,
  toBeVisible,
  toContainElement,
  toContainHTML,
  toHaveAccessibleDescription,
  toHaveAccessibleErrorMessage,
  toHaveAccessibleName,
  toHaveAttribute,
  toHaveClass,
  toHaveDisplayValue,
  toHaveFocus,
  toHaveFormValues,
  toHaveRole,
  toHaveSelection,
  toHaveStyle,
  toHaveTextContent,
  toHaveValue,
} from '@testing-library/jest-dom/matchers';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

// jest-dom 6's /vitest augmentation targets the older one-parameter Assertion.
// Vitest 5 exposes Matchers specifically for extension, including async assertions.
declare module 'vitest' {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > {
    toAppearAfter: TestingLibraryMatchers<T, R>['toAppearAfter'];
    toAppearBefore: TestingLibraryMatchers<T, R>['toAppearBefore'];
    toBeChecked: TestingLibraryMatchers<T, R>['toBeChecked'];
    toBeDisabled: TestingLibraryMatchers<T, R>['toBeDisabled'];
    toBeEmptyDOMElement: TestingLibraryMatchers<T, R>['toBeEmptyDOMElement'];
    toBeEnabled: TestingLibraryMatchers<T, R>['toBeEnabled'];
    toBeInTheDocument: TestingLibraryMatchers<T, R>['toBeInTheDocument'];
    toBeInvalid: TestingLibraryMatchers<T, R>['toBeInvalid'];
    toBePartiallyChecked: TestingLibraryMatchers<T, R>['toBePartiallyChecked'];
    toBePartiallyPressed: TestingLibraryMatchers<T, R>['toBePartiallyPressed'];
    toBePressed: TestingLibraryMatchers<T, R>['toBePressed'];
    toBeRequired: TestingLibraryMatchers<T, R>['toBeRequired'];
    toBeValid: TestingLibraryMatchers<T, R>['toBeValid'];
    toBeVisible: TestingLibraryMatchers<T, R>['toBeVisible'];
    toContainElement: TestingLibraryMatchers<T, R>['toContainElement'];
    toContainHTML: TestingLibraryMatchers<T, R>['toContainHTML'];
    toHaveAccessibleDescription: TestingLibraryMatchers<
      T,
      R
    >['toHaveAccessibleDescription'];
    toHaveAccessibleErrorMessage: TestingLibraryMatchers<
      T,
      R
    >['toHaveAccessibleErrorMessage'];
    toHaveAccessibleName: TestingLibraryMatchers<T, R>['toHaveAccessibleName'];
    toHaveAttribute: TestingLibraryMatchers<T, R>['toHaveAttribute'];
    toHaveClass: TestingLibraryMatchers<T, R>['toHaveClass'];
    toHaveDisplayValue: TestingLibraryMatchers<T, R>['toHaveDisplayValue'];
    toHaveFocus: TestingLibraryMatchers<T, R>['toHaveFocus'];
    toHaveFormValues: TestingLibraryMatchers<T, R>['toHaveFormValues'];
    toHaveRole: TestingLibraryMatchers<T, R>['toHaveRole'];
    toHaveSelection: TestingLibraryMatchers<T, R>['toHaveSelection'];
    toHaveStyle: TestingLibraryMatchers<T, R>['toHaveStyle'];
    toHaveTextContent: TestingLibraryMatchers<T, R>['toHaveTextContent'];
    toHaveValue: TestingLibraryMatchers<T, R>['toHaveValue'];
  }
}

const domMatchers = {
  toAppearAfter,
  toAppearBefore,
  toBeChecked,
  toBeDisabled,
  toBeEmptyDOMElement,
  toBeEnabled,
  toBeInTheDocument,
  toBeInvalid,
  toBePartiallyChecked,
  toBePartiallyPressed,
  toBePressed,
  toBeRequired,
  toBeValid,
  toBeVisible,
  toContainElement,
  toContainHTML,
  toHaveAccessibleDescription,
  toHaveAccessibleErrorMessage,
  toHaveAccessibleName,
  toHaveAttribute,
  toHaveClass,
  toHaveDisplayValue,
  toHaveFocus,
  toHaveFormValues,
  toHaveRole,
  toHaveSelection,
  toHaveStyle,
  toHaveTextContent,
  toHaveValue,
};

expect.extend(domMatchers);

afterEach(() => {
  cleanup();
});
