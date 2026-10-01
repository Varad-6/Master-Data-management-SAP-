using { zmdr as masterdata } from '../db/mdr-maintables';
using { sap } from '@sap/cds/common';

@impl: 'srv/central-handler.js'
service MainDataService @(
  path    : '/mdrapi/maindata',
  // requires: 'authenticated-user'
) {
// Master Data Tables for the UI
  entity GLAccount as projection on masterdata.GLAccount;
  entity BPMaster  as projection on masterdata.BPMaster;
  entity BPStatus  as projection on masterdata.BPStatus;
  entity IndustrySector as projection on masterdata.IndustrySector;
  entity CustomerGroup as projection on masterdata.CustomerGroup;
  @readonly
  entity Countries as projection on sap.common.Countries;
}