sap.ui.define([
    "./BaseController",
    "sap/m/MessageBox",
    "sap/m/Text",
    "sap/m/library",
    "jquery.sap.global",
    "sap/m/Dialog",
    "sap/m/Label",
    "sap/m/TextArea",
    "sap/m/Button",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/util/File"
], (
    BaseController,
    MessageBox,
    Text,
    mobileLiabrary,
    JQuery,
    Dialog,
    Label,
    TextArea,
    Button,
    JSONModel,
    Filter,
    FilterOperator,
    FileUtil
) => {
    "use strict";

    //shortcut
    var ButtonType = mobileLiabrary.ButtonType;
    var DialogType = mobileLiabrary.DialogType;

    return BaseController.extend("com.intapptics.zmdrbulkload.controller.BulkLoad", {
        //Define Global Variables
        this: undefined,
        array: [],
        configArray: [],
        noOfColumns: undefined,
        columnCount: undefined,
        rowDataArr: [],
        categoryName: undefined,
        tableName: undefined,
        dataload: undefined,
        futureVer: "N",
        preserveNull: "N", // overwrite with Null
        finalData: undefined,
        _timeout: undefined,
        InvalidDataModel: undefined,
        temphead: [],
        odataHead: [],
        futureAllowed: undefined,
        workflowReq: undefined,
        filename: undefined,
        dadApprovers: undefined,
        tableappr: undefined,
        ReqEmailId: undefined,
        validRecordCount: undefined,
        workflowidentered: undefined,

        _initCurrentUser: async function () {
            var that = this;
            this.oUserId = this.oUserId || "";
            this.oUserEmail = this.oUserEmail || "";
            this.oUserName = this.oUserName || "";

            var isGuid = function (str) {
                return !str || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str).trim());
            };

            // 1. Try SAP Fiori Launchpad UserInfo Service (Async & Sync)
            try {
                if (typeof sap !== "undefined" && sap.ushell && sap.ushell.Container) {
                    if (sap.ushell.Container.getServiceAsync) {
                        var oUserInfo = await sap.ushell.Container.getServiceAsync("UserInfo");
                        if (oUserInfo) {
                            var sUid = oUserInfo.getId() || "";
                            var sUemail = oUserInfo.getEmail() || "";
                            var sUfullName = oUserInfo.getFullName() || (oUserInfo.getFirstName() ? (oUserInfo.getFirstName() + " " + (oUserInfo.getLastName() || "")).trim() : "");
                            if (sUid) that.oUserId = sUid;
                            if (sUemail) that.oUserEmail = sUemail;
                            if (sUfullName && !isGuid(sUfullName)) that.oUserName = sUfullName;
                        }
                    }
                    if ((!that.oUserId || !that.oUserEmail || !that.oUserName) && sap.ushell.Container.getUser) {
                        var oUser = sap.ushell.Container.getUser();
                        if (oUser) {
                            var sUid2 = oUser.getId() || "";
                            var sUemail2 = oUser.getEmail() || "";
                            var sUfullName2 = oUser.getFullName() || (oUser.getFirstName() ? (oUser.getFirstName() + " " + (oUser.getLastName() || "")).trim() : "");
                            if (sUid2 && !that.oUserId) that.oUserId = sUid2;
                            if (sUemail2 && !that.oUserEmail) that.oUserEmail = sUemail2;
                            if (sUfullName2 && !that.oUserName && !isGuid(sUfullName2)) that.oUserName = sUfullName2;
                        }
                    }
                }
            } catch (e) {
                console.warn("[BulkLoad] Shell UserInfo retrieval note:", e);
            }

            // 2. Try standard SAP BTP User API endpoint (/user-api/currentUser)
            if (!that.oUserEmail || !that.oUserName || isGuid(that.oUserId) || isGuid(that.oUserName)) {
                try {
                    var sUserApiUrl = "/user-api/currentUser";
                    var oUserRes = await fetch(sUserApiUrl, { method: "GET", headers: { "Accept": "application/json" } });
                    if (oUserRes.ok) {
                        var oUserData = await oUserRes.json();
                        if (oUserData.email) that.oUserEmail = oUserData.email;
                        var sName = oUserData.displayName || ([oUserData.firstname, oUserData.lastname].filter(Boolean).join(" ")) || "";
                        if (sName && !isGuid(sName)) that.oUserName = sName;
                        var sUid3 = oUserData.name || oUserData.id || "";
                        if (sUid3 && !isGuid(sUid3)) that.oUserId = sUid3;
                    }
                } catch (e2) {}
            }

            // 3. Try backend /mdrapi/bulk/getCurrentUser() endpoint (decodes JWT token)
            if (!that.oUserEmail || !that.oUserName || isGuid(that.oUserId) || isGuid(that.oUserName)) {
                try {
                    var sServiceUrl = this.getOwnerComponent().getModel().getServiceUrl();
                    var sBaseUrl = sServiceUrl.endsWith("/") ? sServiceUrl.slice(0, -1) : sServiceUrl;
                    var oBackendUserRes = await fetch(sBaseUrl + "/getCurrentUser()", { method: "GET", headers: { "Accept": "application/json" } });
                    if (oBackendUserRes.ok) {
                        var oBData = await oBackendUserRes.json();
                        var oVal = oBData.value || oBData;
                        if (oVal.email) that.oUserEmail = oVal.email;
                        if (oVal.name && !isGuid(oVal.name)) that.oUserName = oVal.name;
                        if (oVal.id && !isGuid(oVal.id)) that.oUserId = oVal.id;
                    }
                } catch (e3) {}
            }

            // 4. Intelligent fallbacks
            if (!that.oUserName || isGuid(that.oUserName)) {
                if (that.oUserEmail) {
                    var localPart = that.oUserEmail.split("@")[0];
                    that.oUserName = localPart.split(/[._-]/).map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); }).join(" ");
                } else if (that.oUserId && !isGuid(that.oUserId)) {
                    that.oUserName = that.oUserId;
                }
            }

            if (!that.oUserEmail && that.oUserId && that.oUserId.includes("@")) {
                that.oUserEmail = that.oUserId;
            }

            if ((!that.oUserId || isGuid(that.oUserId)) && that.oUserEmail) {
                that.oUserId = that.oUserEmail;
            }
        },

        onInit: function () {
            var temp = [],
                filteredCategory = [],
                uniqueCat = [],
                oModel = new JSONModel(),
                oBinding;

            this.getView().byId("table_validresult").setVisible(false);
            this.getView().byId("lbl_warning").setVisible(false);
            this.getView().byId("btn_submit").setVisible(false);
            this.getView().byId("btn_cancel").setVisible(false);
            this.getView().byId("btn_validate").setVisible(false);
            this.getView().byId("btn_reload").setVisible(false);
            this.getView().byId("btn_downloadinvaliddata").setVisible(false);

            // Dynamically resolve current user info across Launchpad / BTP Approuter / Backend
            this._initCurrentUser();

            this.oBulkModel = this.getOwnerComponent().getModel();
            oBinding = this.oBulkModel.bindList("/BulkHdrConfig");
            var oGBusyArray = this.openBusyDialog();

            oBinding.requestContexts().then(function (aContexts) {
                this.closeBusyDialog(oGBusyArray);

                // Convert contexts to data objects (replaces oData.results)
                var aResults = aContexts.map(function (oContext) {
                    return oContext.getObject();
                });

                oModel.setData(aResults);
                //Get the comleted config data in an array
                this.array = oModel.getData();
                this.getOwnerComponent().setModel(oModel, "oModel");

                //get all category
                for (var i = 0; i < this.array.length; i++) {
                    temp.push(this.array[i].Category);
                }
                //push to array, unique category
                for (var j = 0; j < temp.length; j++) {
                    if (uniqueCat.indexOf(temp[j]) === -1) {
                        uniqueCat.push(temp[j]);
                    } else {
                        continue;
                    }
                }

                // Setting objectName
                for (i = 0; i < uniqueCat.length; i++) {
                    filteredCategory.push({
                        categoryName: uniqueCat[i],
                    });
                }

                var oUniqueCategoryModel = new JSONModel(filteredCategory);

                // Set to the component
                this.getOwnerComponent().setModel(oUniqueCategoryModel, "oUniqueCategoryModel");
            }.bind(this)).catch(function (oError) {
                this.closeBusyDialog(oGBusyArray);
                console.error("Error loading BulkHdrConfig:", oError);
            }.bind(this));

            this.getView().byId("cb_workflow").setVisible(false);
            this.getView().byId("inp_workflow").setVisible(false);
            this.workflowidentered = "";
            this.getView().byId("cb_overwritenull").setVisible(false);
            this.getView().byId("cb_updatezonly").setVisible(false);
        },

        handleUploadComplete: function (oEvent) {
            if (this.rowDataArr.length > 0) {
                if (this.noOfColumns === this.columnCount) {
                    var errors = [];
                    // var cleanStr = function (s) {
                    //     return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                    // };
                    for (var i = 0; i < this.odataHead.length; i++) {
                        var uploadedCol = this.temphead[i]; // cleanStr(this.temphead[i]);
                        var expectedCol = this.odataHead[i]; // cleanStr(this.odataHead[i]);
                        if (uploadedCol !== expectedCol) {
                            errors.push(this.temphead[i]);
                            this.getView().byId("btn_validate").setEnabled(false);
                            this.getView().byId("cb_overwritenull").setEnabled(false);
                        }
                    }
                    if (errors.length > 0) {
                        MessageBox.error(
                            "Excel has following invalid column(s) " + errors.join(", ")
                        );
                        this.getView().byId("btn_reload").setVisible(true);
                    } else {
                        this.getView().byId("btn_validate").setVisible(true);
                        this.getView().byId("btn_validate").setEnabled(true);
                        this.getView().byId("btn_reload").setVisible(true);
                    }
                } else {
                    MessageBox.error(
                        "Invalid excel, Please download and use the correct template without any modification in the format."
                    );
                    this.getView().byId("btn_validate").setVisible(false);
                    this.getView().byId("btn_reload").setVisible(true);
                }
            } else {
                MessageBox.error("Uploaded excel contains no data, please check.");
                this.getView().byId("btn_validate").setVisible(false);
                this.getView().byId("btn_reload").setVisible(true);
            }
            //Disable the file uploader
            this.getView().byId("fu_upload").setEnabled(false);
            this.getView().byId("combo_category").setEnabled(false);
            this.getView().byId("combo_tablelist").setEnabled(false);
            this.closeBusyDialog(this.oGlobalBusyDialog);
        },

        onTemplateDownload: function (oEvent) {
            var wb = XLSX.utils.book_new();

            wb.Props = {
                Title: this.tableName,
                Subject: this.tableName,
                Author: "MDR",
                CreatedDate: new Date()
            };
            wb.SheetNames.push(this.tableName);
            var ws_data = [];
            this.odataHead;
            var length = this.odataHead.length;
            var dataStr = [];
            var data = "";
            for (let i = 0; i < length; i++) {
                if (i == length - 1) {
                    data = data + this.odataHead[i];
                } else {
                    data = data + this.odataHead[i] + ";";
                }
            }

            dataStr.push(data);

            ws_data.push(dataStr[0].split(";"));

            var wsData = XLSX.utils.aoa_to_sheet(ws_data);
            wb.Sheets[this.tableName] = wsData;
            var wbout = XLSX.write(wb, {
                bookType: 'xlsx',
                type: 'binary'
            });

            this._saveFile(wbout, (this.tableName || "Template") + ".xlsx");
        },

        _saveFile: function (wbout, fileName) {
            function s2ab(s) {
                var buf = new ArrayBuffer(s.length);
                var view = new Uint8Array(buf);
                for (var i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
                return buf;
            }

            var sType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            var baseName = fileName.replace(/\.xlsx$/i, "");

            if (FileUtil && typeof FileUtil.save === "function") {
                FileUtil.save(s2ab(wbout), baseName, "xlsx", sType, "utf-8");
            } else if (typeof saveAs === "function") {
                saveAs(new Blob([s2ab(wbout)], { type: sType }), fileName);
            } else {
                var oBlob = new Blob([s2ab(wbout)], { type: sType });
                var sUrl = window.URL.createObjectURL(oBlob);
                var oLink = document.createElement("a");
                oLink.style.display = "none";
                oLink.href = sUrl;
                oLink.download = fileName;
                document.body.appendChild(oLink);
                oLink.click();
                setTimeout(function () {
                    document.body.removeChild(oLink);
                    window.URL.revokeObjectURL(sUrl);
                }, 200);
            }
        },

        onFileUpload: function (oEvent) {
            this._import(
                oEvent.getParameter("files") && oEvent.getParameter("files")[0]
            );

            this.filename = oEvent.getParameter("files")[0].name;

            this.oGlobalBusyDialog = this.openBusyDialog();
        },

        _import: function (file) {
            if (file && window.FileReader) {
                var reader = new FileReader();
                reader.onload = function (e) {
                    data = e.target.result;
                    var arr = this.arrayBufferToBase64(data);

                    var wb = XLSX.read(arr, {
                        type: "base64",
                        cellDates: true
                    });

                    var tableName = wb.SheetNames;
                    var data = wb.Sheets[tableName[0]];

                    this.format_excel_data(wb.Sheets[wb.SheetNames[0]], data);
                    this.handleUploadComplete();
                }.bind(this);
                reader.readAsArrayBuffer(file);
            }
        },

        format_excel_data: function (sheet, data) {
            this.temphead = [];
            this.rowDataArr = [];
            var range = XLSX.utils.decode_range(sheet['!ref']);
            this.columnCount = XLSX.utils.decode_range(data['!ref']).e.c + 1;
            var rowData = "";
            var cellDataVal = "";
            for (var rowNum = range.s.r + 1; rowNum <= range.e.r; rowNum++) {
                rowData = "";
                for (var colNum = range.s.c; colNum <= range.e.c; colNum++) {
                    cellDataVal = "";
                    var cellData =
                        sheet[
                        XLSX.utils.encode_cell({
                            r: rowNum,
                            c: colNum,
                        })
                        ];
                    if (cellData !== undefined) {
                        if (cellData.v instanceof Date) {
                            // Safely convert JavaScript Date to HANA expected YYYY-MM-DD format
                            var yyyy = cellData.v.getFullYear();
                            var mm = String(cellData.v.getMonth() + 1).padStart(2, '0');
                            var dd = String(cellData.v.getDate()).padStart(2, '0');
                            cellDataVal = yyyy + "-" + mm + "-" + dd;
                        } else {
                            cellDataVal = typeof cellData.v === "string" ? cellData.v.trim() : cellData.v;
                        }
                        cellDataVal = this._replaceNewLineChar(cellDataVal);
                    }
                    rowData = rowData + "«" + (cellData ? cellDataVal : '');
                }

                if (this.rowDataArr === undefined) {
                    this.rowDataArr = [];
                }
                var newData = rowData.replaceAll("«", "");
                if (newData !== "") {
                    this.rowDataArr.push(rowData.substring(1));
                }
            }

            var result = this.rowDataArr.filter(
                (o) => !Object.keys(o).every(k => !o[k]));
            this.rowDataArr = result;

            //get excel headers
            for (var colNum = range.s.c; colNum <= range.e.c; colNum++) {
                var headData = sheet[XLSX.utils.encode_cell({ r: 0, c: colNum })];
                this.temphead.push(headData.v);
            }
        },

        handleValidateData: function (oEvent) {
            var oBinding,
                oBindingHeader;
            if (this.validateWorkflowId()) {
                MessageBox.error(
                    "Please enter upto 10 digit number for Workflow Number!"
                );
                return;
            } else {
                this.workflowidentered = this.byId("inp_workflow").getValue();

                // [SAFEGUARD] Ensure tableName and rolename are properly populated from UI controls
                var oComboTable = this.byId("combo_tablelist");
                if (oComboTable) {
                    var oSelectedItem = oComboTable.getSelectedItem();
                    var sSelectedKey = oComboTable.getSelectedKey() || (oSelectedItem ? oSelectedItem.getKey() : "");
                    if (sSelectedKey && sSelectedKey.indexOf("+") !== -1) {
                        var aKeyParts = sSelectedKey.split("+");
                        if (!this.tableName) this.tableName = aKeyParts[0];
                        if (!this.rolename) this.rolename = aKeyParts[1];
                    } else if (oSelectedItem) {
                        if (!this.tableName) this.tableName = oSelectedItem.getText();
                    } else if (oComboTable.getValue()) {
                        if (!this.tableName) this.tableName = oComboTable.getValue();
                    }
                }
                if (!this.rolename) {
                    this.rolename = "MDR_BULK_REQUESTOR";
                }
                if (!this.tableName) {
                    MessageBox.error("Please select an Entity from the Entity List first!");
                    return;
                }

                var aFilters = [];
                var oGlobalBusyDialog = this.openBusyDialog();

                var oModel1 = new JSONModel();
                var filter = new Filter(
                    "TableName",
                    FilterOperator.EQ,
                    this.tableName
                );
                var filterStatus = new Filter(
                    "RequestStatus",
                    FilterOperator.EQ,
                    "INPROGRESS"
                );
                aFilters.push(filter);
                aFilters.push(filterStatus);

                oBinding = this.oBulkModel.bindList("/BulkTemp", null, null, aFilters);
                oBinding.requestContexts().then(function (aContexts) {
                    // Convert contexts to data objects (replaces oData.results)
                    var aResults = aContexts.map(function (oContext) {
                        return oContext.getObject();
                    });

                    oModel1.setData(aResults);
                    if (!oModel1.oData.length > 0) {
                        var oDataModel = this.getOwnerComponent().getModel();
                        this.dataload = "N";
                        
                        // Mandatory: tableName and rolename must come from the user's
                        // Category/Entity combo box selection — no hardcoded defaults.
                        var sTableName = this.tableName;
                        var sRoleName = this.rolename;

                        if (!sTableName || !sRoleName) {
                            sap.m.MessageBox.error(
                                "Please select a Category and Entity from the list before uploading data.",
                                { title: "Selection Required" }
                            );
                            return;
                        }

                        // [DEFAULT VALUES] - Set defaults for optional fields if not set by user
                        if (!this.preserveNull) this.preserveNull = "N";
                        if (!this.futurever) this.futurever = "N";
                        if (!this.workflowidentered) this.workflowidentered = "";
                        // [END DEFAULT VALUES]

                        var oEntry = {};
                        var oInData = {};
                        oEntry.Tablename = sTableName;
                        oEntry.Source = "UI";
                        oEntry.Isdataload = this.dataload;// === 'Y' ? true : false;
                        oEntry.Isoverwritewithnull = this.preserveNull;// === 'Y' ? true : false;
                        oEntry.Isfutureversion = this.futurever;// === 'Y' ? true : false;
                        oEntry.Workflowid = this.workflowidentered;
                        var itemData = [];
                        oEntry.NAVOUTINVALIDDATA = [];
                        var lv_res = {};
                        lv_res.Code = "";
                        lv_res.Message = "";
                        oEntry.NAVOUTINVALIDDATA[0] = lv_res;

                        oEntry.NAVOUTVALIDDATA = [];
                        var lv_res1 = {};
                        lv_res1.Data = "";

                        oEntry.NAVOUTVALIDDATA[0] = lv_res1;

                        oEntry.NAVOUTUPDATEDATA = [];
                        var lv_res2 = {};
                        lv_res2.Data = "";

                        oEntry.NAVOUTUPDATEDATA[0] = lv_res2;

                        oEntry.NAVOUTCREATEDATA = [];
                        var lv_res3 = {};
                        lv_res3.Data = "";

                        oEntry.NAVOUTCREATEDATA[0] = lv_res3;

                        oEntry.NAVOUTHEADER = [];
                        var lv_res4 = {};
                        lv_res4.Createcount = 0;
                        lv_res4.Updatecount = 0;
                        lv_res4.Validcount = 0;
                        lv_res4.Invalidcount = 0;
                        lv_res4.Workflowid = "";
                        lv_res4.Tablename = sTableName;

                        oEntry.NAVOUTHEADER[0] = lv_res4;

                        for (var i = 0; i < this.rowDataArr.length; i++) {
                            itemData.push(this.rowDataArr[i]);
                        }

                        console.log("rowDataArr length:", this.rowDataArr.length);
                        console.log("itemData length:", itemData.length);
                        console.log("First item:", itemData[0]);

                        oEntry.NAVINDATA = itemData;
                        oEntry.Requestorsaprole = sRoleName;

                        var oGBusyArray = this.openBusyDialog();

                        // [FIXED] Use direct fetch() instead of OData V4 bindContext
                        // because CAP OData V4 has a known bug where Collection(Edm.String)
                        // parameters arrive as undefined in req.data when called via $batch
                        var sServiceUrl = this.getOwnerComponent().getModel().getServiceUrl();
                        var sBaseUrl = sServiceUrl.endsWith("/") ? sServiceUrl.slice(0, -1) : sServiceUrl;
                        var sActionUrl = sBaseUrl + "/rest/validateBulkData";

                        fetch(sServiceUrl, {
                            method: "GET",
                            headers: {
                                "X-CSRF-Token": "Fetch",
                                "Accept": "application/json"
                            }
                        }).then(function (oTokenResponse) {
                            var sCsrfToken = oTokenResponse.headers.get("X-CSRF-Token") || "";
                            
                            return fetch(sActionUrl, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "Accept": "application/json",
                                    "X-CSRF-Token": sCsrfToken
                                },
                                body: JSON.stringify({
                                    tablename: oEntry.Tablename,
                                    requesterrole: oEntry.Requestorsaprole,
                                    rowData: oEntry.NAVINDATA,
                                    overwriteWithNull: oEntry.Isoverwritewithnull,
                                    futureVersion: oEntry.Isfutureversion,
                                    workflowid: oEntry.Workflowid
                                })
                            });
                        }).then(function (oResponse) {
                            // Read as text first so we can debug if it's not JSON
                            return oResponse.text().then(function (sText) {
                                console.log("Backend response status:", oResponse.status);
                                console.log("Backend response body:", sText);
                                if (!oResponse.ok) {
                                    throw new Error("Server error " + oResponse.status + ": " + sText);
                                }
                                // HTTP 204 No Content: CAP returns this when it cannot serialize
                                // the complex return type of an OData action called via raw fetch.
                                // This typically happens with inline anonymous return types containing
                                // nested arrays. The action DID execute — we need to fix the backend
                                // to return a serializable response.
                                if (oResponse.status === 204 || !sText || sText.trim() === "") {
                                    console.error("CAP returned 204/empty — action ran but response was not serialized. " +
                                        "Check that the action is routed correctly and the return type is serializable.");
                                    throw new Error("Server returned empty response (HTTP " + oResponse.status + "). " +
                                        "The validation action executed but returned no data. Please check server logs.");
                                }
                                return JSON.parse(sText);
                            });
                        }).then(function (oResult) {
                            this.closeBusyDialog(oGBusyArray);

                            // Plain REST endpoint returns direct JSON — no OData 'value' wrapper.
                            // Keep as safe fallback in case OData path is used in the future.
                            if (oResult && oResult.value) {
                                oResult = oResult.value;
                            }

                            this.getView().byId("table_validresult").setVisible(true);

                            // Build header summary
                            var headerData = [{
                                Validcount: oResult.validCount || 0,
                                Invalidcount: oResult.invalidCount || 0,
                                Createcount: oResult.createCount || 0,
                                Updatecount: oResult.updateCount || 0,
                                TotalCount: (oResult.validCount || 0) + (oResult.invalidCount || 0)
                            }];
                            var oHeaderDataModel = new JSONModel(headerData);
                            this.getOwnerComponent().setModel(oHeaderDataModel, "oHeaderDataModel");

                            // Handle invalid data
                            if (oResult.invalidData && oResult.invalidData.length > 0) {
                                this.getView().byId("btn_downloadinvaliddata").setVisible(true);
                                var normalizedInvalidData = oResult.invalidData.map(function (item) {
                                    return {
                                        Code: item.Code || item.code || "",
                                        Message: item.Message || item.message || "",
                                        Rownumber: item.Rownumber || item.rownumber || ""
                                    };
                                });
                                var oInvalidDataModel = new JSONModel(normalizedInvalidData);
                                this.InvalidDataModel = oInvalidDataModel;
                                this.getOwnerComponent().setModel(oInvalidDataModel, "oInvalidDataModel");
                            } else {
                                this.getView().byId("btn_downloadinvaliddata").setVisible(false);
                            }

                            // Handle potential duplicate warnings
                            var hasDuplicates = oResult.duplicateData && oResult.duplicateData.length > 0;
                            if (hasDuplicates) {
                                var normalizedDuplicates = oResult.duplicateData.map(function (item) {
                                    return {
                                        rownumber: item.rownumber || item.Rownumber || "",
                                        code: item.code || item.Code || "",
                                        name: item.name || item.Name || "",
                                        matchedWith: item.matchedWith || item.MatchedWith || "",
                                        score: item.score != null ? item.score : item.Score,
                                        scope: item.scope || item.Scope || (item.matchType === 'DB_FUZZY' ? 'Database Match' : 'In-Batch Fuzzy Match'),
                                        matchType: item.matchType || (item.scope && item.scope.includes('Database') ? 'DB_FUZZY' : 'BATCH_FUZZY'),
                                        message: item.message || item.Message || ""
                                    };
                                });
                                this._aAllDuplicates = normalizedDuplicates;
                                this._setupPaginationDups();
                                if (this.getView().byId("msgstrip_duplicates")) {
                                    this.getView().byId("msgstrip_duplicates").setVisible(true);
                                    this.getView().byId("msgstrip_duplicates").setText(
                                        "⚠️ " + oResult.duplicateData.length + " potential duplicate data field(s) detected (In-Batch & Database). Review and check the confirmation box below to proceed."
                                    );
                                }
                                if (this.getView().byId("tbl_duplicates")) {
                                    this.getView().byId("tbl_duplicates").setVisible(true);
                                }
                                if (this.getView().byId("oftPagingDuplicates")) {
                                    this.getView().byId("oftPagingDuplicates").setVisible(true);
                                }
                                if (this.getView().byId("chk_confirm_duplicates")) {
                                    this.getView().byId("chk_confirm_duplicates").setVisible(true);
                                    this.getView().byId("chk_confirm_duplicates").setSelected(false);
                                }
                            } else {
                                if (this.getView().byId("msgstrip_duplicates")) this.getView().byId("msgstrip_duplicates").setVisible(false);
                                if (this.getView().byId("tbl_duplicates")) this.getView().byId("tbl_duplicates").setVisible(false);
                                if (this.getView().byId("oftPagingDuplicates")) this.getView().byId("oftPagingDuplicates").setVisible(false);
                                if (this.getView().byId("chk_confirm_duplicates")) this.getView().byId("chk_confirm_duplicates").setVisible(false);
                            }

                            // Handle valid data
                            if (oResult.validData && oResult.validData.length > 0) {
                                this.finalData = oResult.validData;
                                this.validData = oResult.validData;
                                this.validRecordCount = oResult.validCount;

                                if (this.validRecordCount > 0) {
                                    this.getView().byId("lbl_warning").setVisible(true);
                                    this.getView().byId("btn_submit").setVisible(true);
                                    this.getView().byId("btn_cancel").setVisible(true);
                                    
                                    // If duplicates exist, require user to check confirmation before submitting
                                    if (hasDuplicates) {
                                        this.getView().byId("btn_submit").setEnabled(false);
                                    } else {
                                        this.getView().byId("btn_submit").setEnabled(true);
                                    }
                                }
                            } else if (!oResult.invalidData || oResult.invalidData.length === 0) {
                                MessageBox.error("No valid records, please upload valid records");
                            }

                            if (oResult.workflowid) {
                                this.workflowId = oResult.workflowid;
                            }

                        }.bind(this)).catch(function (oError) {
                            this.closeBusyDialog(oGBusyArray);
                            MessageBox.error("Error occurred while validating excel data");
                            console.error(oError);
                        }.bind(this));
                        this.getView().byId("cb_overwritenull").setEnabled(false);
                        this.getView().byId("btn_validate").setEnabled(false);
                    } else {
                        this.closeBusyDialog();
                        MessageBox.error(
                            "A request is in-progress for this table, please continue once it is approved"
                        );
                        this.getView().byId("btn_validate").setEnabled(false);
                    }
                }.bind(this)).catch(function (oError) {
                    this.closeBusyDialog(oGlobalBusyDialog);
                    console.error("Error loading BulkTempConfig:", oError);
                }.bind(this));
            }
        },

        onConfirmDuplicatesSelect: function (oEvent) {
            var bConfirmed = oEvent.getParameter("selected");
            if (this.getView().byId("btn_submit")) {
                this.getView().byId("btn_submit").setEnabled(bConfirmed);
            }
        },

        categoryChange: function (oEvent) {
            var filteredTable = [];
            var oUniquTableModel = "";
            var tabEntry = this.array.filter(function (item) {
                return item.Category === oEvent.getSource().getSelectedKey();
            });

            this.categoryName = oEvent.getSource().getSelectedKey();

            var seenTables = {};
            for (var i = 0; i < tabEntry.length; i++) {
                var sTab = tabEntry[i].TableName;
                if (!seenTables[sTab]) {
                    seenTables[sTab] = true;
                    filteredTable.push({
                        TableName: tabEntry[i].TableName,
                        Description: tabEntry[i].TableDescription,
                        Key: tabEntry[i].TableName + "+" + tabEntry[i].RequesterRole,
                    });
                }
            }

            oUniquTableModel = new JSONModel(filteredTable);

            this.getOwnerComponent().setModel(oUniquTableModel, "oUniqueTableModel");
            this.getView().byId("combo_tablelist").setSelectedKey(null);
            this.getView().byId("cb_workflow").setVisible(false);
            this.getView().byId("cb_workflow").setSelected(false);
            this.getView().byId("inp_workflow").setVisible(false);
            this.getView().byId("inp_workflow").setEnabled(false);
            this.getView().byId("inp_workflow").setValue("");
            this.getView().byId("cb_overwritenull").setVisible(false);
            this.getView().byId("cb_overwritenull").setSelected(false);
            this.getView().byId("cb_updatezonly").setVisible(false);
            this.getView().byId("cb_updatezonly").setSelected(false);
            this.getView().byId("btn_Download").setVisible(false);

            this.updateztabonly = "N";
            this.preserveNull = "N";
        },

        checkOverwriteNull: function (oEvent) {
            if (oEvent.getSource().getSelected() === true) {
                this.preserveNull = "Y";
                //open confirmation box
                //This option will overwrite all blank fields in the uploaded template with Null - do you wish to proceed?
            }

            var bSelected = oEvent.getSource().getSelected();
            if (bSelected) {
                if (!this.oApproveDialog) {
                    this.oApproveDialog = new Dialog({
                        type: DialogType.Message,
                        title: "Confirm",
                        content: new Text({
                            text: "This option will overwrite all blank fields in the uploaded template with Null - do you wish to proceed?",
                        }),
                        beginButton: new Button({
                            type: ButtonType.Emphasized,
                            text: "Yes",
                            press: function (oEvent) {
                                if (bSelected) {
                                    this.preserveNull = "Y";
                                } else {
                                    this.preserveNull = "N";
                                }
                                this.oApproveDialog.close();
                            },
                        }),
                        endButton: new Button({
                            text: "No",
                            press: function (oEvent) {
                                this.getView().byId("cb_overwritenull").setSelected(false);
                                this.preserveNull = "N";
                                this.oApproveDialog.close();
                            },
                        }),
                    });
                }
                this.oApproveDialog.open();
            } else {
                this.preserveNull = "N";
            }
        },

        checkUpdateZOnly: function (oEvent) {
            var bSelected = oEvent.getSource().getSelected();
            if (bSelected) {
                if (!this.oApproveDialog) {
                    this.oApproveDialog = new Dialog({
                        type: DialogType.Message,
                        title: "Confirm",
                        content: new Text({
                            text: "Do you want to update z table only",
                        }),
                        beginButton: new Button({
                            type: ButtonType.Emphasized,
                            text: "Yes",
                            press: function (oEvent) {
                                if (bSelected) {
                                    this.updateztabonly = "Y";
                                } else {
                                    this.updateztabonly = "N";
                                }
                                this.oApproveDialog.close();
                            },
                        }),
                        endButton: new Button({
                            text: "No",
                            press: function (oEvent) {
                                this.getView().byId("cb_updatezonly").setSelected(false);
                                this.updateztabonly = "N";
                                this.oApproveDialog.close();
                            },
                        }),
                    });
                }
                this.oApproveDialog.open();
            } else {
                this.updateztabonly = "N";
            }
        },

        checkWorkflow: function (oEvent) {
            if (oEvent.getSource().getSelected() === true) {
                this.getView().byId("inp_workflow").setEnabled(true);
                this.getView().byId("inp_workflow").setVisible(true);
            } else {
                this.getView().byId("inp_workflow").setEnabled(false);
                this.getView().byId("inp_workflow").setVisible(false);
            }
        },

        selectedTable: function (oEvent) {
            var oBinding;
            var oSource = oEvent.getSource();
            var oSelectedItem = oSource.getSelectedItem();
            var sSelectedKey = oSource.getSelectedKey() || (oSelectedItem ? oSelectedItem.getKey() : "");

            var sTableName = "";
            var sRoleName = "MDR_BULK_REQUESTOR";

            if (sSelectedKey && sSelectedKey.indexOf("+") !== -1) {
                var aParts = sSelectedKey.split("+");
                sTableName = aParts[0];
                sRoleName = aParts[1];
            } else if (oSelectedItem) {
                sTableName = oSelectedItem.getText();
            } else {
                sTableName = oSource.getValue();
            }

            this.tableName = sTableName;
            this.rolename = sRoleName;

            var tabEntry = (this.array || []).filter(function (item) {
                return (
                    item.TableName === sTableName &&
                    (!sRoleName || item.RequesterRole === sRoleName)
                );
            });

            var aFilters = [];
            var filterTable = new Filter(
                "TableName",
                FilterOperator.EQ,
                sTableName
            );
            var filterRole = new Filter(
                "RequesterRole",
                FilterOperator.EQ,
                sRoleName
            );

            aFilters.push(filterTable);
            aFilters.push(filterRole);

            var oModelConfig = new JSONModel();
            var oGBusyArray = this.openBusyDialog();

            oBinding = this.oBulkModel.bindList("/BulkItmConfig", null, null, aFilters);
            oBinding.requestContexts().then(function (aContexts) {
                this.closeBusyDialog(oGBusyArray);

                // Convert contexts to data objects (replaces oData.results)
                var aResults = aContexts.map(function (oContext) {
                    return oContext.getObject();
                });

                oModelConfig.setData(aResults);
                this.getOwnerComponent().setModel(oModelConfig, "oModelConfig");
                this.configArray = oModelConfig.getData();
                this.noOfColumns = this.configArray.length;
                if (tabEntry && tabEntry.length > 0) {
                    this.futureAllowed = tabEntry[0].IsFutureVersionAllowed;
                    this.tableappr = tabEntry[0].IsTableLevelApproval;

                    this.workflowReq = tabEntry[0].IsWorkflowVisible;
                    this.preserveNull = tabEntry[0].IsOverwrireWithNull;
                    this.versioned = tabEntry[0].Versioned;
                    this.updatezonly = tabEntry[0].IsUpdateZTableOnly;
                }
                this.updateztabonly = "N";

                if (this.workflowReq === "X") {
                    this.getView().byId("cb_workflow").setVisible(true);
                    this.getView().byId("inp_workflow").setVisible(false);
                    this.getView().byId("inp_workflow").setEnabled(false);
                    this.getView().byId("cb_workflow").setSelected(false);
                    this.getView().byId("inp_workflow").setValue("");
                } else {
                    this.getView().byId("cb_workflow").setVisible(false);
                    this.getView().byId("inp_workflow").setVisible(false);
                    this.getView().byId("inp_workflow").setEnabled(false);
                    this.getView().byId("cb_workflow").setSelected(false);
                    this.getView().byId("inp_workflow").setValue("");
                }
                if (this.preserveNull === "X") {
                    this.getView().byId("cb_overwritenull").setVisible(true);
                    this.getView().byId("cb_overwritenull").setSelected(false);
                    this.preserveNull = "N";
                } else {
                    this.getView().byId("cb_overwritenull").setVisible(true);
                    this.getView().byId("cb_overwritenull").setSelected(false);
                    this.preserveNull = "N";
                }
                if (this.updatezonly === "X") {
                    this.getView().byId("cb_updatezonly").setVisible(true);
                    this.getView().byId("cb_updatezonly").setSelected(false);
                    this.updateztabonly = "N";
                } else {
                    this.getView().byId("cb_updatezonly").setVisible(false);
                    this.getView().byId("cb_updatezonly").setSelected(false);
                    this.updateztabonly = "N";
                }

                this.odataHead = [];
                // Sort columns by sequence number
                this.configArray.sort(function (a, b) {
                    var seqA = (a.ColumnSeqNo !== undefined && a.ColumnSeqNo !== null) ? a.ColumnSeqNo : (a.Colseqno || 0);
                    var seqB = (b.ColumnSeqNo !== undefined && b.ColumnSeqNo !== null) ? b.ColumnSeqNo : (b.Colseqno || 0);
                    return seqA - seqB;
                });
                for (var j = 0; j < this.configArray.length; j++) {
                    var colName = this.configArray[j].ColumnName || this.configArray[j].Columnname;
                    if (colName) {
                        this.odataHead.push(colName);
                    }
                }

                if (this.odataHead.length > 0) {
                    this.getView().byId("btn_Download").setVisible(true);
                } else {
                    this.getView().byId("btn_Download").setVisible(false);
                }
            }.bind(this)).catch(function (oError) {
                this.closeBusyDialog(oGBusyArray);
                console.error("Error loading BulkItmConfig:", oError);
            }.bind(this));
        },

        onInvalidDataExport: function (oEvent) {
            var currentdate = new Date();
            var datetime =
                currentdate.getFullYear() +
                "" +
                ("0" + (currentdate.getMonth() + 1)).slice(-2) +
                "" +
                ("0" + currentdate.getDate()).slice(-2) +
                "" +
                currentdate.getHours() +
                "" +
                currentdate.getMinutes() +
                "" +
                currentdate.getSeconds();

            var wb = XLSX.utils.book_new();
            wb.Props = {
                Title: this.tableName,
                Subject: this.tableName,
                Author: "MDR",
                CreationDate: currentdate,
            };
            wb.SheetNames.push("Invalid Data");
            var ws_data = [];
            var length = this
                .getOwnerComponent()
                .getModel("oInvalidDataModel")
                .getProperty("/").length;
            var dataStr = [];
            dataStr.push("Code«Message«Rownumber");

            var data = this
                .getOwnerComponent()
                .getModel("oInvalidDataModel")
                .getProperty("/");

            for (var i = 0; i < length; i++) {
                var sCode = data[i].Code || data[i].code || "";
                var sMsg = data[i].Message || data[i].message || "";
                var sRowNum = data[i].Rownumber || data[i].rownumber || "";
                dataStr.push(sCode + "«" + sMsg + "«" + sRowNum);
            }

            for (var j = 0; j < length + 1; j++) {
                ws_data.push(dataStr[j].split("«"));
            }

            var wsData = XLSX.utils.aoa_to_sheet(ws_data);
            wb.Sheets["Invalid Data"] = wsData;
            var wbout = XLSX.write(wb, {
                bookType: "xlsx",
                type: "binary",
            });

            this._saveFile(wbout, this.tableName + "_InvalidRecords_" + datetime + ".xlsx");
        },

        onSubmit: function (oEvent) {
            if (this.validateWorkflowId()) {
                MessageBox.error(
                    "Please enter upto 10 digits number for workflow number!"
                );
                return;
            }

            this.workflowidentered = this.byId("inp_workflow").getValue();
            this.getView().byId("btn_submit").setEnabled(false);
            this.getView().byId("btn_cancel").setEnabled(false);

            var oGBusyArray = this.openBusyDialog();

            // Build validData array from finalData — each item must have a 'data' key
            // matching the { data: String } shape expected by the REST endpoint.
            var validData = (this.finalData || []).map(function (item) {
                return { data: item.data || item.Data || "" };
            });

            if (validData.length === 0) {
                this.closeBusyDialog(oGBusyArray);
                this.getView().byId("btn_submit").setEnabled(true);
                this.getView().byId("btn_cancel").setEnabled(true);
                MessageBox.error("No valid records to submit. Please correct the errors in the uploaded file or upload a valid file.");
                return;
            }

            // Use fetch() against the REST endpoint.
            // Rationale: CAP OData V4 returns HTTP 204 (no body) for actions whose
            // return type contains nested arrays of complex types. The REST endpoint
            // at /mdrapi/bulk/rest/submitBulkData bypasses that limitation and returns
            // proper JSON.
            var that = this;
            var sServiceUrl = this.getOwnerComponent().getModel().getServiceUrl();
            var sBaseUrl = sServiceUrl.endsWith("/") ? sServiceUrl.slice(0, -1) : sServiceUrl;
            var sSubmitUrl = sBaseUrl + "/rest/submitBulkData";

            fetch(sServiceUrl, {
                method: "GET",
                headers: {
                    "X-CSRF-Token": "Fetch",
                    "Accept": "application/json"
                }
            }).then(function (oTokenResponse) {
                var sCsrfToken = oTokenResponse.headers.get("X-CSRF-Token") || "";
                
                return fetch(sSubmitUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-CSRF-Token": sCsrfToken
                    },
                    body: JSON.stringify({
                        tablename: that.tableName,
                        requesterrole: that.rolename,
                        validData: validData,
                        overwriteWithNull: that.preserveNull || "N",
                        futureVersion: that.futureAllowed || "N",
                        workflowid: that.workflowidentered || "",
                        remarks: that.sValue || that.remarks || "",
                        userremarks: that.sValue || that.remarks || "",
                        userRemarks: that.sValue || that.remarks || "",
                        requesterid: that.oUserId || "",
                        requesteremail: that.oUserEmail || ((that.oUserId && that.oUserId.includes("@")) ? that.oUserId : ""),
                        requestername: that.oUserName || that.oUserId || ""
                    })
                });
            }).then(function (oResponse) {
                return oResponse.text().then(function (sText) {
                    if (!oResponse.ok) {
                        throw new Error("Server error " + oResponse.status + ": " + sText);
                    }
                    return JSON.parse(sText);
                });
            }).then(function (oResult) {
                this.closeBusyDialog(oGBusyArray);
                this.WorkflowId = oResult.workflowid;

                // Automatically trigger the BPA workflow after a successful submit
                this.onTriggerWF();

                MessageBox.information(
                    "Request submitted successfully with Workflow ID: " + oResult.workflowid,
                    {
                        onClose: function () {
                            window.location.reload();
                        }
                    }
                );

                this.getView().byId("btn_submit").setVisible(false);
                this.getView().byId("btn_cancel").setVisible(false);
                this.getView().byId("lbl_warning").setVisible(false);
            }.bind(this)).catch(function (oError) {
                this.closeBusyDialog(oGBusyArray);
                this.getView().byId("btn_submit").setEnabled(true);
                this.getView().byId("btn_cancel").setEnabled(true);
                MessageBox.error("Error occurred while submitting data. Please check server logs.");
                console.error("[onSubmit] Error:", oError);
            }.bind(this));
        },

        onCancel: function (oEvent) {
            window.location.reload();
        },

        onTriggerWF: function () {
            var that = this;
            var sResolvedTable = this.tableName || this.TableName;
            if (!sResolvedTable) {
                var oComboTable = this.byId("combo_tablelist");
                if (oComboTable) {
                    var sKey = oComboTable.getSelectedKey() || "";
                    if (sKey && sKey.indexOf("+") !== -1) {
                        sResolvedTable = sKey.split("+")[0];
                    } else {
                        sResolvedTable = oComboTable.getValue() || (oComboTable.getSelectedItem() ? oComboTable.getSelectedItem().getText() : "");
                    }
                }
            }

            // Resolve approver class from BulkHdrConfig — the backend reads
            // ApprClass to determine which approver group handles this table.
            var apprClass = "";
            var tabConfig = (this.array || []).find(function (c) {
                return (c.TableName === sResolvedTable || c.Tablename === sResolvedTable) && (c.RequesterRole === that.rolename || c.requesterrole === that.rolename);
            });
            if (tabConfig && (tabConfig.ApprClass || tabConfig.apprclass)) {
                apprClass = tabConfig.ApprClass || tabConfig.apprclass;
            }

            var sUserEmail = this.oUserEmail || (this.oUserId && this.oUserId.includes("@") ? this.oUserId : "");
            var sApproverEmail = (tabConfig && (tabConfig.ApproverEmail || tabConfig.approverEmail)) || sUserEmail || "";

            // Use fetch() against the REST endpoint (OData V4 compatible).
            var sServiceUrl = this.getOwnerComponent().getModel().getServiceUrl();
            var sBaseUrl = sServiceUrl.endsWith("/") ? sServiceUrl.slice(0, -1) : sServiceUrl;
            var sTriggerUrl = sBaseUrl + "/rest/triggerBulkWorkflow";

            fetch(sServiceUrl, {
                method: "GET",
                headers: {
                    "X-CSRF-Token": "Fetch",
                    "Accept": "application/json"
                }
            }).then(function (oTokenResponse) {
                var sCsrfToken = oTokenResponse.headers.get("X-CSRF-Token") || "";
                
                return fetch(sTriggerUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-CSRF-Token": sCsrfToken
                    },
                    body: JSON.stringify({
                        workflowid: that.WorkflowId || "",
                        workflowId: that.WorkflowId || "",
                        sWorkflowID: that.WorkflowId || "",
                        tablename: sResolvedTable,
                        tableName: sResolvedTable,
                        sTablename: sResolvedTable,
                        entityName: sResolvedTable,
                        requestorid: that.oUserId || "",
                        requestorId: that.oUserId || "",
                        requesterid: that.oUserId || "",
                        requesterId: that.oUserId || "",
                        requestoremail: sUserEmail || "",
                        requestorEmail: sUserEmail || "",
                        requesteremail: sUserEmail || "",
                        requesterEmail: sUserEmail || "",
                        requestorname: that.oUserName || that.oUserId || "",
                        requestorName: that.oUserName || that.oUserId || "",
                        requesterName: that.oUserName || that.oUserId || "",
                        requestername: that.oUserName || that.oUserId || "",
                        userremarks: that.sValue || that.remarks || "",
                        userRemarks: that.sValue || that.remarks || "",
                        remarks: that.sValue || that.remarks || "",
                        Remarks: that.sValue || that.remarks || "",
                        operationtype: "BULK UPDATE",
                        operationType: "BULK UPDATE",
                        approverstage: "APPROVER",
                        approverStage: "APPROVER",
                        apprclass: apprClass,
                        approverClass: apprClass,
                        validrecordcount: that.validRecordCount || 0,
                        validRecordCount: that.validRecordCount || 0,
                        requesterrole: that.rolename || "",
                        requesterRole: that.rolename || "",
                        approvers: [
                            {
                                "approverEmail": sApproverEmail,
                                "isCompleted": false,
                                "stage": "APPROVER"
                            }
                        ]
                    })
                });
            }).then(function (oResponse) {
                return oResponse.text().then(function (sText) {
                    if (!oResponse.ok) {
                        throw new Error("WF trigger server error " + oResponse.status + ": " + sText);
                    }
                    return JSON.parse(sText);
                });
            }).then(function (oResult) {
                console.log("[onTriggerWF] Workflow triggered. BPA Instance:", oResult.bpaInstanceId);
            }).catch(function (oError) {
                // Workflow trigger failure is non-blocking — data is already staged.
                // Log the error but do not interrupt the user experience.
                console.error("[onTriggerWF] Workflow trigger failed:", oError);
            });
        },

        handleReloadPress: function () {
            window.location.reload();
        },

        validateWorkflowId: function (oEvent) {
            if (this.byId("inp_workflow").getVisible()) {
                var iWorkflowId = this.byId("inp_workflow").getValue();

                if (iWorkflowId === "" || iWorkflowId === null) {
                    return true;
                } else {
                    var compare = /^[0-9]+$/;
                    if (iWorkflowId.match(compare)) {
                        if (iWorkflowId.length > 10) {
                            return true;
                        } else {
                            this.getView().byId("cb_workflow").setEnabled(false);
                            this.getView().byId("inp_workflow").setEnabled(false);
                            return false;
                        }
                    } else {
                        return true;
                    }
                }
            } else {
                return false;
            }
        },

        onSubmitDialog: function () {
            var that = this;
            if (this.validateWorkflowId()) {
                MessageBox.error(
                    "Please enter upto 10 digits number for Workflow Number!"
                );
            } else {
                var oTextArea = new TextArea({
                    width: "100%",
                    placeholder: "Add Remarks",
                    showExceededText: true,
                    maxLength: 300,
                    liveChange: function (oEvent) {
                        var sText = oEvent.getParameter("value") || "";
                        var remarksLen = sText.length;
                        oEvent.getSource().setValueState(remarksLen > 300 ? "Warning" : "None");
                        oDialog.getBeginButton().setEnabled(sText.trim().length > 0 && remarksLen <= 300);
                    }
                });

                var oDialog = new Dialog({
                    title: "Remarks",
                    type: "Message",
                    content: [
                        new Label({
                            text: "Business Justification",
                            required: true
                        }),
                        oTextArea
                    ],
                    beginButton: new Button({
                        type: ButtonType.Emphasized,
                        text: "Submit",
                        enabled: false,
                        press: function () {
                            var sText = (oTextArea.getValue() || "").trim();
                            that.sValue = sText;
                            that.remarks = sText;
                            oDialog.close();
                            that.onSubmit();
                        }
                    }),
                    endButton: new Button({
                        text: "Cancel",
                        press: function () {
                            oDialog.close();
                        }
                    }),
                    afterClose: function () {
                        oDialog.destroy();
                    }
                });
                oDialog.open();
            }
        },

        arrayBufferToBase64: function (buffer) {
            var binary = "";
            var bytes = new Uint8Array(buffer);
            var len = bytes.byteLength;
            for (var i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        },

        base64ToArrayBuffer: function (base64) {
            var binary_string = window.atob(base64);
            var len = binary_string.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        },

        _replaceNewLineChar: function (oInput) {
            var result = oInput;
            if (isNaN(oInput)) {
                var pattern = /(?:\\[rn]|[\r\n]+)+/g;
                var replacement = "";
                result = oInput.replace(pattern, replacement);
            }
            return result;
        },

        _setupPaginationDups: function () {
            this._iDupsPageSize = parseInt(this.byId("cbxPageSizeDups").getSelectedKey(), 10) || 10;
            this._iDupsRecordCount = this._aAllDuplicates ? this._aAllDuplicates.length : 0;
            
            var iMaxPageNum = Math.ceil(this._iDupsRecordCount / this._iDupsPageSize);
            if (iMaxPageNum === 0) iMaxPageNum = 1;

            this.byId("lblMaxPageNumDups").setText("/" + iMaxPageNum);
            this.byId("inpPageNumDups").setValue(1);

            this._updatePaginationDups(1, iMaxPageNum);
        },

        onPaginationActionDups: function (oEvent) {
            var iCurrPageNum;
            var iMaxPageNum = parseInt(this.byId("lblMaxPageNumDups").getText().substr(1), 10);
            
            switch (oEvent.getSource().getId()) {
                case this.getView().createId("inpPageNumDups"):
                    iCurrPageNum = parseInt(oEvent.getSource().getValue(), 10);
                    if (isNaN(iCurrPageNum) || iCurrPageNum < 1) {
                        iCurrPageNum = 1;
                    } else if (iCurrPageNum > iMaxPageNum) {
                        iCurrPageNum = iMaxPageNum;
                    }
                    break;
                case this.getView().createId("cbxPageSizeDups"):
                    this._iDupsPageSize = parseInt(oEvent.getSource().getSelectedKey(), 10);
                    iMaxPageNum = Math.ceil(this._iDupsRecordCount / this._iDupsPageSize);
                    if (iMaxPageNum === 0) iMaxPageNum = 1;
                    this.byId("lblMaxPageNumDups").setText("/" + iMaxPageNum);
                    iCurrPageNum = 1;
                    break;
                case this.getView().createId("btnFirstPageDups"):
                    iCurrPageNum = 1;
                    break;
                case this.getView().createId("btnPrevPageDups"):
                    iCurrPageNum = parseInt(this.byId("inpPageNumDups").getValue(), 10) - 1;
                    break;
                case this.getView().createId("btnNextPageDups"):
                    iCurrPageNum = parseInt(this.byId("inpPageNumDups").getValue(), 10) + 1;
                    break;
                case this.getView().createId("btnLastPageDups"):
                    iCurrPageNum = iMaxPageNum;
                    break;
            }

            this.byId("inpPageNumDups").setValue(iCurrPageNum);
            this._updatePaginationDups(iCurrPageNum, iMaxPageNum);
        },

        _updatePaginationDups: function (iCurrPageNum, iMaxPageNum) {
            if (iCurrPageNum >= iMaxPageNum) {
                this.byId("btnNextPageDups").setEnabled(false);
                this.byId("btnLastPageDups").setEnabled(false);
            } else {
                this.byId("btnNextPageDups").setEnabled(true);
                this.byId("btnLastPageDups").setEnabled(true);
            }

            if (iCurrPageNum <= 1) {
                this.byId("btnFirstPageDups").setEnabled(false);
                this.byId("btnPrevPageDups").setEnabled(false);
            } else {
                this.byId("btnFirstPageDups").setEnabled(true);
                this.byId("btnPrevPageDups").setEnabled(true);
            }

            var iSkip = (iCurrPageNum - 1) * this._iDupsPageSize;
            var iNum = this._iDupsPageSize;
            
            var aSlicedData = this._aAllDuplicates.slice(iSkip, iSkip + iNum);
            var oDuplicateDataModel = new JSONModel(aSlicedData);
            this.getOwnerComponent().setModel(oDuplicateDataModel, "oDuplicateDataModel");
        } //,

        // //function to show Busy Indicator
        // fn_showBusyIndicator: function (oModelName) {
        //     var oGlobalBusyDialog;
        //     oModelName.attachRequestSent(
        //         function () {
        //             oGlobalBusyDialog = this.openBusyDialog();
        //         }.bind(this)
        //     );
        //     oModelName.attachRequestCompleted(
        //         function () {
        //             this.closeBusyDialog(oGlobalBusyDialog);
        //         }.bind(this)
        //     );
        // },
        // //function to close Busy Indicator
        // fn_closeBusyIndicator: function (oModelName) {
        //     var oGlobalBusyDialog;
        //     oModelName.attachRequestCompleted(
        //         function () {
        //             this.closeBusyDialog(oGlobalBusyDialog);
        //         }.bind(this)
        //     );
        // }
    }
    );
}
);