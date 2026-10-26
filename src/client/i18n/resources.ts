import zhCommon from '../../../locale/zh/common.json' with { type: 'json' };
import zhConfig from '../../../locale/zh/config.json' with { type: 'json' };
import zhPage from '../../../locale/zh/page.json' with { type: 'json' };
import zhAbout from '../../../locale/zh/about.json' with { type: 'json' };
import zhAdvanced from '../../../locale/zh/advanced.json' with { type: 'json' };
import zhLogs from '../../../locale/zh/logs.json' with { type: 'json' };
import zhReviewer from '../../../locale/zh/reviewer.json' with { type: 'json' };
import zhRules from '../../../locale/zh/rules.json' with { type: 'json' };
import zhRuleTest from '../../../locale/zh/ruleTest.json' with { type: 'json' };
import zhStatus from '../../../locale/zh/status.json' with { type: 'json' };
import enCommon from '../../../locale/en/common.json' with { type: 'json' };

/** Explicit imports retain literal Chinese keys and keep JSON in the browser bundle. */
export const localeResources = {
  zh: {
    common: zhCommon,
    config: zhConfig,
    page: zhPage,
    about: zhAbout,
    advanced: zhAdvanced,
    logs: zhLogs,
    reviewer: zhReviewer,
    rules: zhRules,
    ruleTest: zhRuleTest,
    status: zhStatus,
  },
  en: {
    common: enCommon,
  },
};
