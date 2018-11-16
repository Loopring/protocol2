var LRCToken                = artifacts.require("./test/tokens/LRC.sol");
var GTOToken                = artifacts.require("./test/tokens/GTO.sol");
var RDNToken                = artifacts.require("./test/tokens/RDN.sol");
var REPToken                = artifacts.require("./test/tokens/REP.sol");
var WETHToken               = artifacts.require("./test/tokens/WETH.sol");
var STAToken                = artifacts.require("./test/tokens/STA.sol");
var TESTToken               = artifacts.require("./test/tokens/TEST.sol");
var SECTESTToken            = artifacts.require("./test/tokens/SECTEST.sol");

module.exports = function(deployer, network, accounts) {
  if (network === "live") {
    // ignore
  } else {
    deployer.deploy(LRCToken);
    deployer.deploy(GTOToken);
    deployer.deploy(RDNToken);
    deployer.deploy(REPToken);
    deployer.deploy(WETHToken);
    deployer.deploy(STAToken);
    deployer.deploy(TESTToken);
    deployer.deploy(SECTESTToken);
  }

};
