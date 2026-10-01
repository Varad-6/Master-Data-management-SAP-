using zmdr from '../db/mdr-dad';

@impl: 'srv/admin-handler.js'
service AdminService @(
  path    : '/mdrapi/admin',
  requires: 'authenticated-user'
) {
  entity Approver      as projection on zmdr.Approver;
  entity ApproverClass as projection on zmdr.ApproverClass;
  entity Policy        as projection on zmdr.Policy;

  action adminApproveRejectWorkflow(
      applicationType : String,
      entityType      : String,
      entityNumber    : String,
      workflowId      : String,
      remarks         : String,
      action          : String
  ) returns { 
      success : Boolean; 
      message : String 
  };
}
