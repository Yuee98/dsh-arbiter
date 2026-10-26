import zhCoexistence from '../../../locale/zh/coexistence.json' with { type: 'json' };
import zhCommon from '../../../locale/zh/common.json' with { type: 'json' };
import zhConfig from '../../../locale/zh/config.json' with { type: 'json' };
import zhPage from '../../../locale/zh/page.json' with { type: 'json' };
import zhAbout from '../../../locale/zh/about.json' with { type: 'json' };
import zhAdvanced from '../../../locale/zh/advanced.json' with { type: 'json' };
import zhCallDetail from '../../../locale/zh/callDetail.json' with { type: 'json' };
import zhDenials from '../../../locale/zh/denials.json' with { type: 'json' };
import zhLogs from '../../../locale/zh/logs.json' with { type: 'json' };
import zhReviewer from '../../../locale/zh/reviewer.json' with { type: 'json' };
import zhRules from '../../../locale/zh/rules.json' with { type: 'json' };
import zhRuleTest from '../../../locale/zh/ruleTest.json' with { type: 'json' };
import zhStatus from '../../../locale/zh/status.json' with { type: 'json' };
import zhPermission from '../../../locale/zh/permission.json' with { type: 'json' };
import enAbout from '../../../locale/en/about.json' with { type: 'json' };
import enAdvanced from '../../../locale/en/advanced.json' with { type: 'json' };
import enCallDetail from '../../../locale/en/callDetail.json' with { type: 'json' };
import enCoexistence from '../../../locale/en/coexistence.json' with { type: 'json' };
import enCommon from '../../../locale/en/common.json' with { type: 'json' };
import enConfig from '../../../locale/en/config.json' with { type: 'json' };
import enDenials from '../../../locale/en/denials.json' with { type: 'json' };
import enLogs from '../../../locale/en/logs.json' with { type: 'json' };
import enPage from '../../../locale/en/page.json' with { type: 'json' };
import enPermission from '../../../locale/en/permission.json' with { type: 'json' };
import enReviewer from '../../../locale/en/reviewer.json' with { type: 'json' };
import enRuleTest from '../../../locale/en/ruleTest.json' with { type: 'json' };
import enRules from '../../../locale/en/rules.json' with { type: 'json' };
import enStatus from '../../../locale/en/status.json' with { type: 'json' };

/** Explicit imports retain literal Chinese keys and keep JSON in the browser bundle. */
export const localeResources = {
  zh: {
    coexistence: zhCoexistence,
    common: zhCommon,
    config: zhConfig,
    page: zhPage,
    about: zhAbout,
    advanced: zhAdvanced,
    callDetail: zhCallDetail,
    denials: zhDenials,
    logs: zhLogs,
    reviewer: zhReviewer,
    rules: zhRules,
    ruleTest: zhRuleTest,
    status: zhStatus,
    permission: zhPermission,
  },
  en: {
    about: enAbout,
    advanced: enAdvanced,
    callDetail: enCallDetail,
    coexistence: enCoexistence,
    common: enCommon,
    config: enConfig,
    denials: enDenials,
    logs: enLogs,
    page: enPage,
    permission: enPermission,
    reviewer: enReviewer,
    ruleTest: enRuleTest,
    rules: enRules,
    status: enStatus,
  },
};
