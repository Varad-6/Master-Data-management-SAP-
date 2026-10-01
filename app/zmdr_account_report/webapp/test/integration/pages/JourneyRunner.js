sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"com/intapptics/zmdraccountreport/test/integration/pages/GLAccountList.gen",
	"com/intapptics/zmdraccountreport/test/integration/pages/GLAccountObjectPage.gen"
], function (JourneyRunner, GLAccountListGenerated, GLAccountObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('com/intapptics/zmdraccountreport') + '/test/flp.html#app-preview',
        pages: {
			onTheGLAccountListGenerated: GLAccountListGenerated,
			onTheGLAccountObjectPageGenerated: GLAccountObjectPageGenerated
        },
        async: true
    });

    return runner;
});

