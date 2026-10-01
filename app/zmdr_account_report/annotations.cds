using MainDataService as service from '../../srv/maindata-service';

annotate service.GLAccount with @(
    UI: {
        HeaderInfo: {
            TypeName: 'Account',
            TypeNamePlural: 'Accounts',
            Title: { Value: GlAccountNum },
            Description: { Value: AccountDesc }
        },
        SelectionFields: [
            CompanyCode,
            GlAccountNum,
            Status,
            WorkflowId
        ],
        LineItem: [
            { Value: GlAccountNum, Label: 'Account Number' },
            { Value: CompanyCode, Label: 'Chart of Accounts' },
            { Value: WorkflowId, Label: 'Workflow ID' },
            { Value: Status, Label: 'Status' },
            { Value: AccountDesc, Label: 'Account Description' },
            { Value: AccountType, Label: 'Account Type' },
            { Value: Currency, Label: 'Currency' },
            { Value: VersionActive, Label: 'Version Active' },
            { Value: VersionStartDate, Label: 'Version Start Date' },
            { Value: VersionEndDate, Label: 'Version End Date' },
            { Value: CreatedOn, Label: 'Created On' },
            { Value: CreatedBy, Label: 'Created By' },
            { Value: UpdatedOn, Label: 'Updated On' },
            { Value: UpdatedBy, Label: 'Updated By' }
        ],
        Facets: [
            {
                $Type: 'UI.ReferenceFacet',
                ID: 'AccountDetails',
                Label: 'Account Details',
                Target: '@UI.FieldGroup#AccountDetails'
            },
            {
                $Type: 'UI.ReferenceFacet',
                ID: 'VersionInfo',
                Label: 'Version Information',
                Target: '@UI.FieldGroup#VersionInfo'
            },
            {
                $Type: 'UI.ReferenceFacet',
                ID: 'AdminInfo',
                Label: 'Administrative Information',
                Target: '@UI.FieldGroup#AdminInfo'
            }
        ],
        FieldGroup#AccountDetails: {
            Data: [
                { Value: GlAccountNum, Label: 'Account Number' },
                { Value: CompanyCode, Label: 'Chart of Accounts' },
                { Value: AccountDesc, Label: 'Account Description' },
                { Value: AccountType, Label: 'Account Type' },
                { Value: Currency, Label: 'Currency' },
                { Value: Status, Label: 'Status' },
                { Value: WorkflowId, Label: 'Workflow ID' }
            ]
        },
        FieldGroup#VersionInfo: {
            Data: [
                { Value: VersionActive, Label: 'Version Active' },
                { Value: VersionStartDate, Label: 'Version Start Date' },
                { Value: VersionEndDate, Label: 'Version End Date' }
            ]
        },
        FieldGroup#AdminInfo: {
            Data: [
                { Value: CreatedOn, Label: 'Created On' },
                { Value: CreatedBy, Label: 'Created By' },
                { Value: UpdatedOn, Label: 'Updated On' },
                { Value: UpdatedBy, Label: 'Updated By' }
            ]
        }
    }
);